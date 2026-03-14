import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { PrismaService } from '../prisma/prisma.service';
import { BusinessRolesGuard } from '../common/auth/business-roles.guard';
import { ServicesModule } from '../services/services.module';

@Module({
  imports: [ServicesModule],
  controllers: [BookingsController],
  providers: [BookingsService, PrismaService, BusinessRolesGuard, Reflector],
  exports: [BookingsService],
})
export class BookingsModule {}
