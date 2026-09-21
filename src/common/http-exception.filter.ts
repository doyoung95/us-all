import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppLogger } from '../logger/app-logger.service.js';

type ExceptionBody = { message?: string | string[] };

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    // 4xx 는 정상 흐름이라 스택까지 남기면 소음이 된다. 예상 못 한 에러만 추적한다
    if (!isHttp) {
      this.logger.error('http.error', exception, {
        method: req.method,
        url: req.originalUrl,
      });
    }

    // getResponse() 는 문자열이거나 { message } 객체다 → 한 모양으로 정규화
    const raw = isHttp ? exception.getResponse() : null;
    const body = typeof raw === 'object' && raw ? (raw as ExceptionBody) : null;
    const message =
      typeof raw === 'string'
        ? [raw]
        : Array.isArray(body?.message)
          ? body.message
          : [body?.message ?? '서버 오류가 발생했습니다.'];

    res.status(status).json({
      statusCode: status,
      message,
    });
  }
}
