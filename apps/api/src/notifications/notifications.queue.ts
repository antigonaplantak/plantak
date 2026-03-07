import { Injectable } from '@nestjs/common';

export type NotificationJob = {
  type: string;
  payload: Record<string, unknown>;
};

@Injectable()
export class NotificationsQueue {
  push(job: NotificationJob): void {
    process.stdout.write(`[notifications] queued ${job.type}\n`);
    void job;
  }
}
