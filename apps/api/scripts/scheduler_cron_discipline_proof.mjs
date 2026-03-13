import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`.replace(
  /[^a-zA-Z0-9_-]/g,
  '',
);

const workdir = process.cwd();
const dir = join(workdir, '_scheduler_runs');
const dataFile = join(dir, `proof-${runId}.jsonl`);
const logA = join(dir, `proof-${runId}-A.log`);
const logB = join(dir, `proof-${runId}-B.log`);

await fs.mkdir(dir, { recursive: true });
await Promise.all([
  fs.rm(dataFile, { force: true }),
  fs.rm(logA, { force: true }),
  fs.rm(logB, { force: true }),
]);

async function appendFileSafe(file, chunk) {
  await fs.appendFile(file, chunk).catch(() => {});
}

function start(name) {
  const logFile = name === 'A' ? logA : logB;

  const child = spawn('node', ['dist/scheduler/scheduler.worker.js'], {
    cwd: workdir,
    env: {
      ...process.env,
      SCHEDULER_PROOF: '1',
      SCHEDULER_PROOF_RUN_ID: runId,
      SCHEDULER_PROOF_TTL_MS: '4000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    void appendFileSafe(logFile, chunk);
  });

  child.stderr.on('data', (chunk) => {
    void appendFileSafe(logFile, chunk);
  });

  return { name, child, logFile };
}

async function readJsonLines(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function waitFor(fn, timeoutMs, intervalMs = 200) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return null;
}

async function stopChild(proc) {
  if (!proc || proc.killed) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  proc.kill('SIGTERM');

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {}
      resolve();
    }, 4000);

    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

const A = start('A');
const B = start('B');

try {
  console.log('## PROOF RUN ID');
  console.log(runId);

  const firstExecution = await waitFor(async () => {
    const lines = await readJsonLines(dataFile);
    return lines[0] ?? null;
  }, 12000);

  if (!firstExecution) {
    throw new Error('timeout waiting for first scheduler execution');
  }

  const firstLeader =
    firstExecution.pid === A.child.pid
      ? A
      : firstExecution.pid === B.child.pid
      ? B
      : null;

  if (!firstLeader) {
    throw new Error(`unknown first leader pid=${firstExecution.pid}`);
  }

  console.log('## FIRST EXECUTION');
  console.log(firstExecution);

  await stopChild(firstLeader.child);

  const failoverExecution = await waitFor(async () => {
    const lines = await readJsonLines(dataFile);
    return lines.find((line) => line.pid !== firstExecution.pid) ?? null;
  }, 12000);

  if (!failoverExecution) {
    throw new Error('timeout waiting for scheduler failover execution');
  }

  console.log('## FAILOVER EXECUTION');
  console.log(failoverExecution);

  if (failoverExecution.pid === firstExecution.pid) {
    throw new Error('failover execution came from the same process');
  }

  console.log('SCHEDULER_CRON_DISCIPLINE_PROOF_OK');
} finally {
  await stopChild(A.child);
  await stopChild(B.child);

  console.log('## PROC A');
  console.log({
    pid: A.child.pid,
    exitCode: A.child.exitCode,
    signalCode: A.child.signalCode,
  });

  console.log('## PROC B');
  console.log({
    pid: B.child.pid,
    exitCode: B.child.exitCode,
    signalCode: B.child.signalCode,
  });

  console.log('## LOG A');
  try {
    console.log(await fs.readFile(logA, 'utf8'));
  } catch {
    console.log('n/a');
  }

  console.log('## LOG B');
  try {
    console.log(await fs.readFile(logB, 'utf8'));
  } catch {
    console.log('n/a');
  }
}
