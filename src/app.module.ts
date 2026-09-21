import { MiddlewareConsumer, Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerMiddleware } from './common/logger.middleware.js';
import { RuntimeModule } from './common/runtime/runtime.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { LoggerModule } from './logger/logger.module.js';

@Module({
  imports: [JobsModule, ScheduleModule.forRoot(), RuntimeModule, LoggerModule],
  controllers: [],
  providers: [],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
