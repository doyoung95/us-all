import { Module } from '@nestjs/common';
import { RecoverJobService } from './recover-job.service.js';

@Module({
  providers: [RecoverJobService],
  exports: [RecoverJobService],
})
export class RecoverJobModule {}
