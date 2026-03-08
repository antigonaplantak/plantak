import { Injectable } from '@nestjs/common';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

@Injectable()
export class QueueSinkService {
  private readonly dir = join(process.cwd(), '_queue_runs');

  async write(queue: string, payload: Record<string, unknown>) {
    await fs.mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${queue}.jsonl`);
    const line = JSON.stringify({
      at: new Date().toISOString(),
      queue,
      ...payload,
    }) + '\n';
    await fs.appendFile(file, line, 'utf8');
  }
}
