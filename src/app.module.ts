import { MiddlewareConsumer, Module } from '@nestjs/common';
import { LoggerMiddleware } from './common/logger.middleware.js';
import { JobsModule } from './jobs/jobs.module.js';

@Module({
  imports: [JobsModule],
  controllers: [],
  providers: [],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
