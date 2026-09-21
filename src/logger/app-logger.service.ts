import { Injectable } from '@nestjs/common';
import { createWriteStream } from 'fs';

export type LogMeta = Record<string, string | number | boolean | undefined>;

@Injectable()
export class AppLogger {
  private readonly stream = createWriteStream(
    process.env.LOG_FILE ?? 'logs.txt',
    { flags: 'a' },
  );

  log(event: string, meta: LogMeta = {}) {
    this.write('LOG', event, meta);
  }

  warn(event: string, meta: LogMeta = {}) {
    this.write('WARN', event, meta);
  }

  error(event: string, error?: unknown, meta: LogMeta = {}) {
    this.write('ERROR', event, meta);

    if (error instanceof Error) {
      this.stream.write(`${error.stack ?? error.message}\n`);
      return;
    }
    if (error !== undefined) {
      this.stream.write(`${String(error)}\n`);
    }
  }

  close() {
    return new Promise<void>((resolve) => this.stream.end(resolve));
  }

  private write(level: string, event: string, meta: LogMeta) {
    const fields = Object.entries(meta)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');

    this.stream.write(
      `[${new Date().toISOString()}] [${level}] ${event}${fields ? ` ${fields}` : ''}\n`,
    );
  }
}
