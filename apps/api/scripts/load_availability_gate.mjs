import { performance } from 'node:perf_hooks';

const API = process.env.API ?? 'http://localhost:3001/api';
const BUSINESS_ID = process.env.BUSINESS_ID ?? 'b1';
const SERVICE_ID = process.env.SERVICE_ID ?? 'f37eca6e-8729-4a73-a498-028436514c1b';
const STAFF_ID = process.env.STAFF_ID ?? 'b9b77322-1012-4860-af1b-5b53a6171d06';
const TZ = process.env.TZ_NAME ?? 'Europe/Paris';

const TOTAL = Number(process.env.TOTAL ?? 1000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const MAX_P95_MS = Number(process.env.MAX_P95_MS ?? 800);
const LOAD_BYPASS_TOKEN = process.env.LOAD_BYPASS_TOKEN ?? '';

function futureDate(days = 120) {
  const d = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

const DATE_YMD = process.env.DATE_YMD ?? futureDate(120);

const url =
  `${API}/availability?businessId=${encodeURIComponent(BUSINESS_ID)}` +
  `&serviceId=${encodeURIComponent(SERVICE_ID)}` +
  `&staffId=${encodeURIComponent(STAFF_ID)}` +
  `&date=${encodeURIComponent(DATE_YMD)}` +
  `&tz=${encodeURIComponent(TZ)}`;

const headers = LOAD_BYPASS_TOKEN
  ? { 'x-internal-load-key': LOAD_BYPASS_TOKEN }
  : {};

console.log('== LOAD CONFIG ==');
console.log(
  JSON.stringify(
    {
      url,
      TOTAL,
      CONCURRENCY,
      MAX_P95_MS,
      LOAD_BYPASS_TOKEN: LOAD_BYPASS_TOKEN ? 'set' : 'unset',
    },
    null,
    2,
  ),
);
console.log();

async function oneRequest(i) {
  const start = performance.now();
  const res = await fetch(url, { headers });
  const text = await res.text();
  const ms = performance.now() - start;

  if (!res.ok) {
    console.log(`REQ_${i}_FAILED status=${res.status} body=${text}`);
  }

  return { ok: res.ok, status: res.status, ms };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

const results = [];
let next = 1;

async function worker() {
  while (true) {
    const i = next++;
    if (i > TOTAL) return;
    results.push(await oneRequest(i));
  }
}

const wallStart = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
const wallMs = performance.now() - wallStart;

const ok = results.filter((r) => r.ok).length;
const failed = results.length - ok;

const msSorted = results.map((r) => r.ms).sort((a, b) => a - b);
const avg = msSorted.reduce((a, b) => a + b, 0) / (msSorted.length || 1);

const statuses = {};
for (const r of results) statuses[r.status] = (statuses[r.status] ?? 0) + 1;

const p50 = percentile(msSorted, 50);
const p95 = percentile(msSorted, 95);
const p99 = percentile(msSorted, 99);
const max = msSorted.length ? msSorted[msSorted.length - 1] : 0;
const rps = results.length / (wallMs / 1000);

console.log('== LOAD RESULT ==');
console.log(`TOTAL=${TOTAL}`);
console.log(`OK=${ok}`);
console.log(`FAILED=${failed}`);
console.log(`WALL_MS=${wallMs.toFixed(2)}`);
console.log(`RPS=${rps.toFixed(2)}`);
console.log(`AVG_MS=${avg.toFixed(2)}`);
console.log(`P50_MS=${p50.toFixed(2)}`);
console.log(`P95_MS=${p95.toFixed(2)}`);
console.log(`P99_MS=${p99.toFixed(2)}`);
console.log(`MAX_MS=${max.toFixed(2)}`);
console.log(`STATUSES=${JSON.stringify(statuses, null, 2)}`);

if (failed > 0) {
  console.error('LOAD_GATE_FAIL: request failures detected');
  process.exit(1);
}

if (p95 > MAX_P95_MS) {
  console.error(`LOAD_GATE_FAIL: p95 ${p95.toFixed(2)}ms > ${MAX_P95_MS}ms`);
  process.exit(1);
}

console.log('LOAD_GATE_OK');
