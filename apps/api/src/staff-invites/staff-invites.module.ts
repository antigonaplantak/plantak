import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StaffInvitesController } from './staff-invites.controller';
import { StaffInvitesService } from './staff-invites.service';

@Module({
  imports: [PrismaModule],
  controllers: [StaffInvitesController],
  providers: [StaffInvitesService],
})
export class StaffInvitesModule {}
