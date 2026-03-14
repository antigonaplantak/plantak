import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RuntimeSafetyModule } from '../runtime/runtime-safety.module';
import { LeasedCronService } from './leased-cron.service';
import { SchedulerProofService } from './scheduler-proof.service';

@Module({
  imports: [ScheduleModule.forRoot(), RuntimeSafetyModule],
  providers: [LeasedCronService, SchedulerProofService],
})
export class SchedulerWorkerModule {}
