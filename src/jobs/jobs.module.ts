import { Module } from '@nestjs/common';
import { RuntimeModule } from '../common/runtime/runtime.module.js';
import { JobsController } from './jobs.controller.js';
import { JobsService } from './jobs.service.js';

@Module({
  imports: [RuntimeModule],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}
