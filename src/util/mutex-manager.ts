import { Injectable } from '@nestjs/common';
import { Mutex } from './mutex.js';

@Injectable()
export class MutexManager {
  private readonly mutexes = new Map<string, Mutex>();

  private get(key: string): Mutex {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(key, mutex);
    }
    return mutex;
  }

  async run(key: string, cb: () => Promise<void>) {
    const mutex = this.get(key);

    await mutex.acquire();

    try {
      return await cb();
    } finally {
      mutex.release();
      if (mutex.isIdle()) {
        this.mutexes.delete(key);
      }
    }
  }
}
