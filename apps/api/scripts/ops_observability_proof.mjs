import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

function run(cmd, args) {
  const res = spawnSync(cmd, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with status=${res.status}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

run('pnpm', ['run', 'outbox:multi-instance:proof']);
run('pnpm', ['run', 'scheduler:proof']);
run('pnpm', ['run', 'backpressure:proof']);
run('node', ['scripts/ops_runtime_snapshot.mjs']);

const reportPath = join(process.cwd(), '_ops_reports', 'runtime-snapshot.latest.json');
assert(fs.existsSync(reportPath), 'runtime snapshot report missing');

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

assert(report.generatedAt, 'generatedAt missing');
assert(report.queues?.notifications, 'notifications queue snapshot missing');
assert(report.queues?.['notifications-dlq'], 'notifications-dlq snapshot missing');
assert(report.queues?.webhooks, 'webhooks queue snapshot missing');
assert(report.queues?.['sync-jobs'], 'sync-jobs queue snapshot missing');

assert(
  Array.isArray(report.outbox?.detectedTables) && report.outbox.detectedTables.length >= 1,
  'no outbox table detected',
);

assert(
  Array.isArray(report.runtimeLeases?.detectedTables) && report.runtimeLeases.detectedTables.length >= 1,
  'no runtime lease table detected',
);

console.log('OBSERVABILITY_DEEPER_PROOF_OK');
console.log(JSON.stringify({
  generatedAt: report.generatedAt,
  outboxTables: report.outbox.detectedTables,
  runtimeLeaseTables: report.runtimeLeases.detectedTables,
  queueNames: Object.keys(report.queues),
}, null, 2));
