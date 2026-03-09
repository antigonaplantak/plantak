import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const LOG_A = '/tmp/outbox-lease-a.log';
const LOG_B = '/tmp/outbox-lease-b.log';

const proofLeaseKey =
  `runtime:lease:outbox-dispatcher-proof:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

const env = {
  ...process.env,
  OUTBOX_DISPATCHER_LEASE_KEY: proofLeaseKey,
  OUTBOX_DISPATCHER_LEASE_TTL_MS: '4000',
  OUTBOX_DISPATCHER_LEASE_RENEW_MS: '1000',
  OUTBOX_POLL_MS: '500',
};

async function read(path) {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function waitFor(fn, timeoutMs, stepMs = 300) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

function linesContaining(text, needle) {
  return text.split('\n').filter((line) => line.includes(needle));
}

function startWorker(name, logFile) {
  const child = spawn(process.execPath, ['dist/outbox/outbox-dispatcher.worker.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const state = {
    name,
    child,
    logFile,
    exitCode: null,
    exitSignal: null,
  };

  child.stdout.on('data', async (chunk) => {
    await fs.appendFile(logFile, chunk);
  });

  child.stderr.on('data', async (chunk) => {
    await fs.appendFile(logFile, chunk);
  });

  child.on('exit', (code, signal) => {
    state.exitCode = code;
    state.exitSignal = signal;
  });

  return state;
}

function describeState(state) {
  return {
    name: state.name,
    pid: state.child.pid,
    exitCode: state.exitCode,
    exitSignal: state.exitSignal,
  };
}

async function stopWorker(state) {
  if (!state?.child?.pid) return;
  if (state.exitCode !== null || state.exitSignal !== null) return;

  state.child.kill('SIGTERM');
  await sleep(1200);

  if (state.exitCode === null && state.exitSignal === null) {
    state.child.kill('SIGKILL');
    await sleep(500);
  }
}

await fs.rm(LOG_A, { force: true });
await fs.rm(LOG_B, { force: true });

const a = startWorker('A', LOG_A);
const b = startWorker('B', LOG_B);

let failure = null;

try {
  console.log('## PROOF LEASE KEY');
  console.log(proofLeaseKey);

  const firstLeader = await waitFor(async () => {
    const [la, lb] = await Promise.all([read(LOG_A), read(LOG_B)]);
    const aLeaders = linesContaining(la, 'OUTBOX_LEADER_ACTIVE');
    const bLeaders = linesContaining(lb, 'OUTBOX_LEADER_ACTIVE');
    const fatals = [
      ...linesContaining(la, 'OUTBOX_WORKER_FATAL'),
      ...linesContaining(la, 'OUTBOX_LEASE_STEP_FAILED'),
      ...linesContaining(lb, 'OUTBOX_WORKER_FATAL'),
      ...linesContaining(lb, 'OUTBOX_LEASE_STEP_FAILED'),
    ];

    if (fatals.length) return { type: 'fatal' };
    if (aLeaders.length > 0 && bLeaders.length > 0) return { type: 'split-brain' };
    if (aLeaders.length === 1 && bLeaders.length === 0) return { type: 'ok', leader: 'A' };
    if (aLeaders.length === 0 && bLeaders.length === 1) return { type: 'ok', leader: 'B' };
    return null;
  }, 20000);

  if (!firstLeader || firstLeader.type !== 'ok') {
    throw new Error(`initial leader failed: ${firstLeader ? firstLeader.type : 'timeout'}`);
  }

  const leaderState = firstLeader.leader === 'A' ? a : b;
  const followerState = firstLeader.leader === 'A' ? b : a;

  leaderState.child.kill('SIGTERM');

  const failover = await waitFor(async () => {
    const followerText = await read(followerState.logFile);
    const followerLeaders = linesContaining(followerText, 'OUTBOX_LEADER_ACTIVE');
    if (followerLeaders.length >= 1) return { type: 'ok' };
    return null;
  }, 20000);

  console.log('## FIRST LEADER');
  console.log(firstLeader);
  console.log('\n## FAILOVER');
  console.log(failover);

  if (!failover || failover.type !== 'ok') {
    throw new Error('failover proof failed');
  }

  console.log('\nOUTBOX_MULTI_INSTANCE_LEASE_PROOF_OK');
} catch (error) {
  failure = error;
} finally {
  await stopWorker(a);
  await stopWorker(b);

  const finalA = await read(LOG_A);
  const finalB = await read(LOG_B);

  console.log('\n## PROC A');
  console.log(describeState(a));
  console.log('\n## PROC B');
  console.log(describeState(b));
  console.log('\n## LOG A');
  console.log(finalA);
  console.log('\n## LOG B');
  console.log(finalB);

  if (failure) {
    throw failure;
  }
}
