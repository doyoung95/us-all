import { Module } from '@nestjs/common';
import { RuntimeService } from './runtime.service.js';

@Module({
  providers: [RuntimeService],
  exports: [RuntimeService],
})
export class RuntimeModule {}
