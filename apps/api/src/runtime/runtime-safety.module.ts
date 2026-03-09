import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { RuntimeLeaseService } from './runtime-lease.service';

@Module({
  imports: [PrismaModule],
  providers: [RuntimeLeaseService],
  exports: [RuntimeLeaseService],
})
export class RuntimeSafetyModule {}
