import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { LeasedCronService } from './leased-cron.service';

@Injectable()
export class SchedulerProofService {
  private readonly logger = new Logger(SchedulerProofService.name);
  private readonly enabled = process.env.SCHEDULER_PROOF === '1';
  private readonly runId = process.env.SCHEDULER_PROOF_RUN_ID ?? 'disabled';
  private readonly ttlMs = Number(process.env.SCHEDULER_PROOF_TTL_MS ?? 4000);
  private readonly leaseKey = `runtime:lease:scheduler-proof:${this.runId}`;
  private readonly file = join(
    process.cwd(),
    '_scheduler_runs',
    `proof-${this.runId}.jsonl`,
  );

  constructor(private readonly leasedCronService: LeasedCronService) {}

  @Cron('*/1 * * * * *', { name: 'scheduler-proof' })
  async proofTick() {
    if (!this.enabled) return;

    const execution = await this.leasedCronService.runWithLease({
      jobName: 'scheduler-proof',
      leaseKey: this.leaseKey,
      ttlMs: this.ttlMs,
      task: async () => {
        await fs.mkdir(dirname(this.file), { recursive: true });

        const payload = {
          at: new Date().toISOString(),
          pid: process.pid,
          ownerId: this.leasedCronService.getOwnerId(),
          leaseKey: this.leaseKey,
        };

        await fs.appendFile(this.file, JSON.stringify(payload) + '\n');

        console.log(
          `SCHEDULER_PROOF_EXECUTED ownerId=${payload.ownerId} pid=${payload.pid} leaseKey=${payload.leaseKey}`,
        );

        return payload;
      },
    });

    if (execution.executed) {
      this.logger.log(`scheduler proof executed runId=${this.runId}`);
    }
  }
}
