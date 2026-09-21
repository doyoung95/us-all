import { Injectable } from '@nestjs/common';

@Injectable()
export class RuntimeService {
  private readonly startedAt = Date.now();

  getRunningSec() {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }
}
