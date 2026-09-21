import { Module } from '@nestjs/common';
import { RuntimeModule } from '../common/runtime/runtime.module.js';
import { MutexManager } from '../util/mutex-manager.js';
import { JobsController } from './jobs.controller.js';
import { JobsScheduler } from './jobs.scheduler.js';
import { JobsService } from './jobs.service.js';
import { JOB_MUTEX_MANAGER } from './jobs.token.js';

@Module({
  imports: [RuntimeModule],
  controllers: [JobsController],
  providers: [
    {
      provide: JOB_MUTEX_MANAGER,
      useFactory: () => new MutexManager(),
    },
    JobsService,
    JobsScheduler,
  ],
})
export class JobsModule {}
