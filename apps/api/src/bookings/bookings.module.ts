import { Module } from '@nestjs/common';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { BusinessRolesGuard } from '../common/auth/business-roles.guard';
import { Reflector } from '@nestjs/core';

import { NotificationsModule } from '../notifications/notifications.module';
@Module({
  imports: [NotificationsModule],
  controllers: [BookingsController],
  providers: [BookingsService, PrismaService, BusinessRolesGuard, Reflector],
  exports: [BookingsService],
})
export class BookingsModule {}
