import { RedisBackpressureService } from '../dist/queue/backpressure/redis-backpressure.service.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const policyKey = `proof:backpressure:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
const options = {
  policyKey,
  maxPerWindow: 2,
  windowMs: 1000,
  maxConcurrent: 1,
  acquireTimeoutMs: 15000,
  maxHoldMs: 5000,
};

const minSpacingMs = Math.ceil(options.windowMs / options.maxPerWindow);

const serviceA = new RedisBackpressureService();
const serviceB = new RedisBackpressureService();

const starts = [];
let live = 0;
let maxLive = 0;

async function runOne(service, id) {
  return service.runWithBudget(options, async () => {
    const at = Date.now();
    live += 1;
    maxLive = Math.max(maxLive, live);

    starts.push({
      id,
      at,
      iso: new Date(at).toISOString(),
      instanceId: service.getInstanceId(),
      live,
    });

    await sleep(150);
    live -= 1;
    return id;
  });
}

try {
  const tasks = [
    runOne(serviceA, 'A1'),
    runOne(serviceB, 'B1'),
    runOne(serviceA, 'A2'),
    runOne(serviceB, 'B2'),
    runOne(serviceA, 'A3'),
    runOne(serviceB, 'B3'),
  ];

  await Promise.all(tasks);
  starts.sort((a, b) => a.at - b.at);

  for (let i = 1; i < starts.length; i += 1) {
    const delta = starts[i].at - starts[i - 1].at;
    assert(
      delta >= minSpacingMs - 20,
      `strict pacing broken between ${starts[i - 1].id} and ${starts[i].id}: deltaMs=${delta}`,
    );
  }

  assert(maxLive <= 1, `max concurrent broken maxLive=${maxLive}`);

  console.log('BACKPRESSURE_GLOBAL_PROOF_OK');
  console.log(JSON.stringify({ policyKey, minSpacingMs, maxLive, starts }, null, 2));
} finally {
  await serviceA.onModuleDestroy();
  await serviceB.onModuleDestroy();
}
