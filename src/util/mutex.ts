export class Mutex {
  private locked = false;
  private queue: (() => void)[] = [];
  constructor() {}

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release() {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }

    this.locked = false;
  }

  isIdle() {
    return !this.locked && this.queue.length === 0;
  }
}
