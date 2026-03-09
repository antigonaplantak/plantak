import { INestApplicationContext, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { OutboxDispatcherModule } from './outbox-dispatcher.module';
import { RuntimeSafetyModule } from '../runtime/runtime-safety.module';
import {
  RuntimeLeaseGrant,
  RuntimeLeaseService,
} from '../runtime/runtime-lease.service';

const logger = new Logger('OutboxDispatcherWorker');

const LEASE_KEY =
  process.env.OUTBOX_DISPATCHER_LEASE_KEY ??
  'runtime:lease:outbox-dispatcher';

const LEASE_TTL_MS = Number(
  process.env.OUTBOX_DISPATCHER_LEASE_TTL_MS ?? '15000',
);

const LEASE_RENEW_MS = Number(
  process.env.OUTBOX_DISPATCHER_LEASE_RENEW_MS ?? '5000',
);

function mark(message: string) {
  console.log(message);
}

function markError(message: string) {
  console.error(message);
}

function fmtError(error: unknown) {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

function assertPositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

async function bootstrap() {
  assertPositive('OUTBOX_DISPATCHER_LEASE_TTL_MS', LEASE_TTL_MS);
  assertPositive('OUTBOX_DISPATCHER_LEASE_RENEW_MS', LEASE_RENEW_MS);

  const ownerId = `${hostname()}:${process.pid}:${randomUUID()}`;

  mark(`OUTBOX_BOOT_1_BEGIN ownerId=${ownerId}`);

  const leaseApp = await NestFactory.createApplicationContext(
    RuntimeSafetyModule,
    { logger: ['log', 'warn', 'error'] },
  );

  mark(`OUTBOX_BOOT_2_LEASE_APP_READY ownerId=${ownerId}`);

  const leases = leaseApp.get(RuntimeLeaseService);

  mark(`OUTBOX_BOOT_3_LEASE_SERVICE_READY ownerId=${ownerId}`);

  let dispatcherApp: INestApplicationContext | null = null;
  let stopping = false;
  let currentFence: bigint | null = null;

  const becomeLeader = async (grant: RuntimeLeaseGrant) => {
    if (dispatcherApp) return;

    mark(`OUTBOX_BOOT_4_BECOME_LEADER_BEGIN ownerId=${ownerId} fencingToken=${grant.fencingToken.toString()}`);

    try {
      dispatcherApp = await NestFactory.createApplicationContext(
        OutboxDispatcherModule,
        { logger: ['log', 'warn', 'error'] },
      );

      currentFence = grant.fencingToken;

      mark(
        `OUTBOX_LEADER_ACTIVE leaseKey=${grant.leaseKey} ownerId=${ownerId} fencingToken=${grant.fencingToken.toString()}`,
      );

      logger.log(
        `outbox leader active leaseKey=${grant.leaseKey} ownerId=${ownerId} fencingToken=${grant.fencingToken.toString()}`,
      );
    } catch (error) {
      markError(
        `OUTBOX_LEADER_BOOT_FAILED ownerId=${ownerId} error=${fmtError(error)}`,
      );

      if (dispatcherApp) {
        await dispatcherApp.close().catch(() => undefined);
        dispatcherApp = null;
      }

      currentFence = null;
      await leases.release(LEASE_KEY, ownerId).catch(() => undefined);
    }
  };

  const becomeFollower = async () => {
    if (!dispatcherApp) return;

    mark(
      `OUTBOX_LEADER_LOST leaseKey=${LEASE_KEY} ownerId=${ownerId} fencingToken=${currentFence?.toString() ?? 'n/a'}`,
    );

    await dispatcherApp.close();
    dispatcherApp = null;
    currentFence = null;
  };

  const step = async () => {
    if (stopping) return;

    mark(`OUTBOX_STEP_BEGIN ownerId=${ownerId} hasDispatcher=${dispatcherApp ? 'yes' : 'no'}`);

    try {
      const grant = dispatcherApp
        ? await leases.renew(LEASE_KEY, ownerId, LEASE_TTL_MS)
        : await leases.tryAcquire(LEASE_KEY, ownerId, LEASE_TTL_MS);

      mark(`OUTBOX_STEP_AFTER_LEASE ownerId=${ownerId} granted=${grant ? 'yes' : 'no'}`);

      if (grant) {
        currentFence = grant.fencingToken;
        if (!dispatcherApp) {
          await becomeLeader(grant);
        }
        return;
      }

      if (dispatcherApp) {
        await becomeFollower();
      }
    } catch (error) {
      markError(
        `OUTBOX_LEASE_STEP_FAILED ownerId=${ownerId} error=${fmtError(error)}`,
      );
      logger.error(`outbox lease step failed ownerId=${ownerId} error=${fmtError(error)}`);
    }
  };

  const timer = setInterval(() => {
    void step();
  }, LEASE_RENEW_MS);

  await step();

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;

    clearInterval(timer);

    mark(`OUTBOX_WORKER_SHUTDOWN signal=${signal} ownerId=${ownerId}`);

    if (dispatcherApp) {
      await dispatcherApp.close().catch(() => undefined);
      dispatcherApp = null;
    }

    await leases.release(LEASE_KEY, ownerId).catch((error) => {
      markError(`OUTBOX_LEASE_RELEASE_FAILED ownerId=${ownerId} error=${fmtError(error)}`);
    });

    await leaseApp.close().catch((error) => {
      markError(`OUTBOX_LEASE_APP_CLOSE_FAILED ownerId=${ownerId} error=${fmtError(error)}`);
    });

    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

void bootstrap().catch((error) => {
  markError(`OUTBOX_WORKER_FATAL error=${fmtError(error)}`);
  process.exit(1);
});
