import { performance } from 'node:perf_hooks';

const TOTAL = Number(process.env.TOTAL || 2000);
const CONCURRENCY = Number(process.env.CONCURRENCY || 80);
const MAX_P95_MS = Number(process.env.MAX_P95_MS || 800);

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';
const BUSINESS_ID = process.env.BUSINESS_ID || 'b1';
const SERVICE_ID = process.env.SERVICE_ID || 'f37eca6e-8729-4a73-a498-028436514c1b';
const STAFF_ID = process.env.STAFF_ID || 'b9b77322-1012-4860-af1b-5b53a6171d06';
const TZ = process.env.TZ || 'Europe/Paris';
const BASE_DATE = process.env.BASE_DATE || '2026-07-06';

const LOAD_BYPASS_TOKEN = process.env.LOAD_BYPASS_TOKEN || '';

function addDays(ymd, plusDays) {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10);
}

function buildUrl(i) {
  const date = addDays(BASE_DATE, i); // unique date per request => cold path
  const u = new URL('/api/availability', BASE_URL);
  u.searchParams.set('businessId', BUSINESS_ID);
  u.searchParams.set('serviceId', SERVICE_ID);
  u.searchParams.set('staffId', STAFF_ID);
  u.searchParams.set('date', date);
  u.searchParams.set('tz', TZ);
  return u.toString();
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

const durations = [];
const statuses = new Map();
let ok = 0;
let failed = 0;
let nextIndex = 0;

const headers = {};
if (LOAD_BYPASS_TOKEN) {
  headers['x-load-bypass-token'] = LOAD_BYPASS_TOKEN;
  headers['x-throttle-bypass-token'] = LOAD_BYPASS_TOKEN;
  headers['x-bypass-token'] = LOAD_BYPASS_TOKEN;
}

async function one(i) {
  const started = performance.now();
  try {
    const res = await fetch(buildUrl(i), { headers });
    const ms = performance.now() - started;

    durations.push(ms);
    statuses.set(String(res.status), (statuses.get(String(res.status)) || 0) + 1);

    if (res.ok) ok++;
    else failed++;

    await res.arrayBuffer().catch(() => {});
  } catch {
    const ms = performance.now() - started;
    durations.push(ms);
    statuses.set('FETCH_ERR', (statuses.get('FETCH_ERR') || 0) + 1);
    failed++;
  }
}

async function worker() {
  while (true) {
    const i = nextIndex++;
    if (i >= TOTAL) return;
    await one(i);
  }
}

console.log('== COLD LOAD CONFIG ==');
console.log(JSON.stringify({
  TOTAL,
  CONCURRENCY,
  MAX_P95_MS,
  BASE_URL,
  BUSINESS_ID,
  SERVICE_ID,
  STAFF_ID,
  TZ,
  BASE_DATE,
  uniqueDates: TOTAL,
  LOAD_BYPASS_TOKEN: LOAD_BYPASS_TOKEN ? 'set' : 'unset'
}, null, 2));

const wallStart = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const wallMs = performance.now() - wallStart;

durations.sort((a, b) => a - b);

const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
const p50 = percentile(durations, 50);
const p95 = percentile(durations, 95);
const p99 = percentile(durations, 99);
const max = durations.length ? durations[durations.length - 1] : 0;

const statusObj = Object.fromEntries([...statuses.entries()].sort((a, b) => a[0].localeCompare(b[0])));

console.log('\n== COLD LOAD RESULT ==');
console.log(`TOTAL=${TOTAL}`);
console.log(`OK=${ok}`);
console.log(`FAILED=${failed}`);
console.log(`WALL_MS=${wallMs.toFixed(2)}`);
console.log(`RPS=${(TOTAL / (wallMs / 1000)).toFixed(2)}`);
console.log(`AVG_MS=${avg.toFixed(2)}`);
console.log(`P50_MS=${p50.toFixed(2)}`);
console.log(`P95_MS=${p95.toFixed(2)}`);
console.log(`P99_MS=${p99.toFixed(2)}`);
console.log(`MAX_MS=${max.toFixed(2)}`);
console.log(`STATUSES=${JSON.stringify(statusObj, null, 2)}`);

if (failed > 0) {
  console.error('COLD_LOAD_GATE_FAILED: request failures detected');
  process.exit(1);
}

if (p95 > MAX_P95_MS) {
  console.error(`COLD_LOAD_GATE_FAILED: P95 ${p95.toFixed(2)}ms > ${MAX_P95_MS}ms`);
  process.exit(1);
}

console.log('COLD_LOAD_GATE_OK');
