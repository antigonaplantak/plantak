import { Global, Module } from '@nestjs/common';
import { RedisBackpressureService } from './redis-backpressure.service';

@Global()
@Module({
  providers: [RedisBackpressureService],
  exports: [RedisBackpressureService],
})
export class BackpressureModule {}
