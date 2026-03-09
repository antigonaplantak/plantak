import { Module, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { Queue } from 'bullmq';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line no-var
  var __plantakQueueDashboardMounted: boolean | undefined;
}

function envBool(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) ? raw : fallback;
}

function redisConnection() {
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: envInt('REDIS_PORT', 6379),
    db: envInt('REDIS_DB', 0),
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

function unauthorized(res: Response) {
  res.setHeader('WWW-Authenticate', 'Basic realm="queue-dashboard"');
  res.status(401).send('Authentication required');
}

@Module({})
export class QueueDashboardModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueDashboardModule.name);
  private readonly queues: Queue[] = [];

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  async onModuleInit() {
    if (!envBool('ENABLE_QUEUE_DASHBOARD', false)) {
      this.logger.log('queue dashboard disabled');
      return;
    }

    if (globalThis.__plantakQueueDashboardMounted) {
      this.logger.warn('queue dashboard already mounted');
      return;
    }

    const http = this.httpAdapterHost.httpAdapter;
    const app = http.getInstance();

    if (!app?.use) {
      throw new Error('Queue dashboard requires the default Express adapter');
    }

    const route = process.env.QUEUE_DASHBOARD_ROUTE || '/api/ops/queues';
    const connection = redisConnection();

    const queueNames = [
      'notifications',
      'webhooks',
      'sync-jobs',
      'notifications-dlq',
      'webhooks-dlq',
      'sync-jobs-dlq',
    ];

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath(route);

    const adapters = queueNames.map((name) => {
      const queue = new Queue(name, { connection });
      this.queues.push(queue);
      return new BullMQAdapter(queue, { readOnlyMode: true });
    });

    createBullBoard({
      queues: adapters,
      serverAdapter,
      options: {
        uiConfig: {
          boardTitle: 'Plantak Queue Ops',
          hideRedisDetails: true,
        },
      },
    });

    const auth = (req: Request, res: Response, next: NextFunction) => {
      const user = process.env.QUEUE_DASHBOARD_USER;
      const pass = process.env.QUEUE_DASHBOARD_PASS;

      if (!user || !pass) {
        res.status(503).send('Queue dashboard credentials are not configured');
        return;
      }

      const header = req.headers.authorization;
      if (!header || !header.startsWith('Basic ')) {
        unauthorized(res);
        return;
      }

      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const givenUser = separator >= 0 ? decoded.slice(0, separator) : decoded;
      const givenPass = separator >= 0 ? decoded.slice(separator + 1) : '';

      if (givenUser !== user || givenPass !== pass) {
        unauthorized(res);
        return;
      }

      next();
    };

    app.use(route, auth, serverAdapter.getRouter());
    globalThis.__plantakQueueDashboardMounted = true;

    this.logger.log(`queue dashboard ready route=${route}`);
  }

  async onModuleDestroy() {
    await Promise.all(
      this.queues.map((queue) => queue.close().catch(() => undefined)),
    );
  }
}
