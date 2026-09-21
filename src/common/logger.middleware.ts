import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { AppLogger } from '../logger/app-logger.service.js';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  constructor(private readonly logger: AppLogger) {}

  use(req: Request, res: Response, next: NextFunction) {
    const startedAt = Date.now();

    // 미들웨어는 핸들러보다 먼저 끝나므로, 상태 코드는 응답이 나간 뒤에야 알 수 있다
    res.on('finish', () => {
      this.logger.log('http.request', {
        method: req.method,
        // req.url 은 마운트 경로가 잘려 '/' 로만 찍힌다
        url: req.originalUrl,
        status: res.statusCode,
        ms: Date.now() - startedAt,
      });
    });

    next();
  }
}
