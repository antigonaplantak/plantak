import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { PrismaClient } from '@prisma/client';

function loadDotEnv() {
  const envPath = join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function qident(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function parseRedisConnection() {
  const rawUrl = process.env.BULLMQ_URL || process.env.REDIS_URL;
  if (rawUrl) {
    const u = new URL(rawUrl);
    const dbFromPath = u.pathname && u.pathname !== '/' ? Number(u.pathname.slice(1)) : 0;
    return {
      host: u.hostname || '127.0.0.1',
      port: Number(u.port || 6379),
      username: u.username || undefined,
      password: u.password || undefined,
      db: Number.isFinite(dbFromPath) ? dbFromPath : 0,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
  }

  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

async function readDirSignal(dirPath) {
  try {
    const entries = await fsp.readdir(dirPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const abs = join(dirPath, entry.name);
      const stat = await fsp.stat(abs);
      files.push({
        name: entry.name,
        size: stat.size,
        mtimeIso: stat.mtime.toISOString(),
      });
    }
    files.sort((a, b) => (a.mtimeIso < b.mtimeIso ? 1 : -1));
    return {
      exists: true,
      fileCount: files.length,
      latestFiles: files.slice(0, 5),
    };
  } catch {
    return {
      exists: false,
      fileCount: 0,
      latestFiles: [],
    };
  }
}

async function getQueueSnapshot(queueName, connection) {
  const queue = new Queue(queueName, { connection });
  try {
    const counts = await queue.getJobCounts(
      'wait',
      'active',
      'delayed',
      'completed',
      'failed',
      'paused',
      'prioritized',
      'waiting-children',
    );

    return {
      wait: counts.wait ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      paused: counts.paused ?? 0,
      prioritized: counts.prioritized ?? 0,
      waitingChildren: counts['waiting-children'] ?? 0,
    };
  } finally {
    await queue.close();
  }
}

loadDotEnv();

const prisma = new PrismaClient();
const connection = parseRedisConnection();

const snapshot = {
  generatedAt: new Date().toISOString(),
  redisConnection: {
    host: connection.host,
    port: connection.port,
    db: connection.db ?? 0,
  },
  queues: {},
  outbox: {
    detectedTables: [],
    tables: {},
  },
  runtimeLeases: {
    detectedTables: [],
    tables: {},
  },
  directorySignals: {},
};

try {
  const queueNames = [
    'notifications',
    'webhooks',
    'sync-jobs',
    'notifications-dlq',
    'webhooks-dlq',
    'sync-jobs-dlq',
  ];

  for (const queueName of queueNames) {
    snapshot.queues[queueName] = await getQueueSnapshot(queueName, connection);
  }

  const outboxTables = await prisma.$queryRawUnsafe(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (
        lower(table_name) LIKE '%outbox%'
      )
    ORDER BY table_name ASC
  `);

  snapshot.outbox.detectedTables = outboxTables.map((x) => x.table_name);

  for (const row of outboxTables) {
    const tableName = row.table_name;
    const columns = await prisma.$queryRawUnsafe(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = '${tableName}'
      ORDER BY ordinal_position ASC
    `);

    const columnSet = new Set(columns.map((x) => x.column_name));
    const statusColumn =
      columnSet.has('status') ? 'status' :
      columnSet.has('state') ? 'state' :
      null;

    const updatedAtColumn =
      columnSet.has('updatedAt') ? 'updatedAt' :
      columnSet.has('updated_at') ? 'updated_at' :
      null;

    const item = {
      rowCount: 0,
      byStatus: {},
      staleProcessingCount: null,
    };

    const rowCountRes = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count
      FROM public.${qident(tableName)}
    `);
    item.rowCount = rowCountRes[0]?.count ?? 0;

    if (statusColumn) {
      const byStatus = await prisma.$queryRawUnsafe(`
        SELECT ${qident(statusColumn)}::text AS key, COUNT(*)::int AS count
        FROM public.${qident(tableName)}
        GROUP BY 1
        ORDER BY 1
      `);
      for (const row2 of byStatus) {
        item.byStatus[row2.key ?? 'NULL'] = row2.count ?? 0;
      }

      if (updatedAtColumn) {
        const stale = await prisma.$queryRawUnsafe(`
          SELECT COUNT(*)::int AS count
          FROM public.${qident(tableName)}
          WHERE ${qident(statusColumn)} = 'PROCESSING'
            AND ${qident(updatedAtColumn)} < NOW() - INTERVAL '5 minutes'
        `);
        item.staleProcessingCount = stale[0]?.count ?? 0;
      }
    }

    snapshot.outbox.tables[tableName] = item;
  }

  const runtimeLeaseTables = await prisma.$queryRawUnsafe(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND (
        lower(table_name) LIKE '%runtime%lease%'
        OR lower(table_name) LIKE '%lease%'
      )
    ORDER BY table_name ASC
  `);

  snapshot.runtimeLeases.detectedTables = runtimeLeaseTables.map((x) => x.table_name);

  for (const row of runtimeLeaseTables) {
    const tableName = row.table_name;
    const columns = await prisma.$queryRawUnsafe(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = '${tableName}'
      ORDER BY ordinal_position ASC
    `);

    const columnSet = new Set(columns.map((x) => x.column_name));
    const expiresAtColumn =
      columnSet.has('expiresAt') ? 'expiresAt' :
      columnSet.has('expires_at') ? 'expires_at' :
      null;

    const leaseKeyColumn =
      columnSet.has('leaseKey') ? 'leaseKey' :
      columnSet.has('lease_key') ? 'lease_key' :
      null;

    const ownerIdColumn =
      columnSet.has('ownerId') ? 'ownerId' :
      columnSet.has('owner_id') ? 'owner_id' :
      null;

    const fencingTokenColumn =
      columnSet.has('fencingToken') ? 'fencingToken' :
      columnSet.has('fencing_token') ? 'fencing_token' :
      null;

    const rowCountRes = await prisma.$queryRawUnsafe(`
      SELECT COUNT(*)::int AS count
      FROM public.${qident(tableName)}
    `);

    const item = {
      rowCount: rowCountRes[0]?.count ?? 0,
      activeCount: null,
      staleCount: null,
      leaders: [],
    };

    if (expiresAtColumn) {
      const activeRes = await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS count
        FROM public.${qident(tableName)}
        WHERE ${qident(expiresAtColumn)} > NOW()
      `);
      item.activeCount = activeRes[0]?.count ?? 0;

      const staleRes = await prisma.$queryRawUnsafe(`
        SELECT COUNT(*)::int AS count
        FROM public.${qident(tableName)}
        WHERE ${qident(expiresAtColumn)} <= NOW()
      `);
      item.staleCount = staleRes[0]?.count ?? 0;
    }

    if (leaseKeyColumn && ownerIdColumn) {
      const selectExtra = fencingTokenColumn ? `, ${qident(fencingTokenColumn)}::text AS "fencingToken"` : '';
      const orderExtra = expiresAtColumn ? `${qident(expiresAtColumn)} DESC` : `${qident(leaseKeyColumn)} ASC`;

      const leaders = await prisma.$queryRawUnsafe(`
        SELECT
          ${qident(leaseKeyColumn)}::text AS "leaseKey",
          ${qident(ownerIdColumn)}::text AS "ownerId"
          ${selectExtra}
          ${expiresAtColumn ? `, ${qident(expiresAtColumn)} AS "expiresAt"` : ''}
        FROM public.${qident(tableName)}
        ORDER BY ${orderExtra}
        LIMIT 10
      `);

      item.leaders = leaders;
    }

    snapshot.runtimeLeases.tables[tableName] = item;
  }

  snapshot.directorySignals._queue_runs = await readDirSignal(join(process.cwd(), '_queue_runs'));
  snapshot.directorySignals._scheduler_runs = await readDirSignal(join(process.cwd(), '_scheduler_runs'));
  snapshot.directorySignals._ops_reports = await readDirSignal(join(process.cwd(), '_ops_reports'));

  await fsp.mkdir(join(process.cwd(), '_ops_reports'), { recursive: true });
  await fsp.writeFile(
    join(process.cwd(), '_ops_reports', 'runtime-snapshot.latest.json'),
    JSON.stringify(snapshot, null, 2),
    'utf8',
  );

  console.log('OPS_RUNTIME_SNAPSHOT_OK');
  console.log(JSON.stringify(snapshot, null, 2));
} finally {
  await prisma.$disconnect();
}
