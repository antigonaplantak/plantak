import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_FILTER } from '@nestjs/core';
import { StaffInvitesModule } from './staff-invites/staff-invites.module';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { ServicesModule } from './services/services.module';
import { AvailabilityModule } from './availability/availability.module';
import { BookingsModule } from './bookings/bookings.module';
import { InfraModule } from './infra/infra.module';
import { QueueModule } from './queue/queue.module';
import { AuditLogInterceptor } from './common/interceptors/audit-log.interceptor';
import { SentryFilter } from './common/sentry/sentry.filter';

@Module({
  providers: [
    { provide: APP_FILTER, useClass: SentryFilter },
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor }],
  imports: [
    InfraModule,
    QueueModule,

    StaffInvitesModule,
    PrismaModule,
    AuthModule,
    HealthModule,
    ServicesModule,
    AvailabilityModule,
    BookingsModule],
})
export class AppModule {}
