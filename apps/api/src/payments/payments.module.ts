import { Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { BookingsModule } from '../bookings/bookings.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { BusinessRolesGuard } from '../common/auth/business-roles.guard';

@Module({
  imports: [PrismaModule, BookingsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, BusinessRolesGuard, Reflector],
})
export class PaymentsModule {}
