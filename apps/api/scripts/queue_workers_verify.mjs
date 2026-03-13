import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), '_queue_runs');
const files = ['notifications.jsonl', 'webhooks.jsonl', 'sync-jobs.jsonl'];

async function main() {
  for (const f of files) {
    const p = join(dir, f);
    try {
      const raw = await fs.readFile(p, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const last = lines.slice(-3).map((x) => JSON.parse(x));
      console.log(`== ${f} ==`);
      console.log(JSON.stringify(last, null, 2));
    } catch {
      console.log(`== ${f} ==`);
      console.log('missing');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
