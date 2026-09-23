import { mkdir, open, readFile, rename, unlink } from 'fs/promises';
import { IAdapter } from 'node-json-db';
import { dirname } from 'path';

export class AtomicFileAdapter implements IAdapter<string> {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  private async atomicWrite(data: string): Promise<void> {
    const temp = `${this.path}.tmp`;
    await mkdir(dirname(this.path), { recursive: true });

    try {
      const file = await open(temp, 'w');
      try {
        await file.writeFile(data, 'utf-8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, this.path);
    } catch (err) {
      await unlink(temp).catch(() => {});

      throw err;
    }
  }

  async readAsync(): Promise<string | null> {
    try {
      return await readFile(this.path, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }
  writeAsync(data: string): Promise<void> {
    const write = this.pending.then(() => this.atomicWrite(data));
    this.pending = write.catch(() => {});

    return write;
  }
}
