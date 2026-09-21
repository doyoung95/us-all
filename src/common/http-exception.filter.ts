import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    const isHttp = exception instanceof HttpException;
    if (!isHttp) {
      console.error(exception);
    }
    const status = isHttp
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const raw = isHttp ? exception.getResponse() : null;
    const message =
      typeof raw === 'string'
        ? [raw]
        : Array.isArray((raw as any)?.message)
          ? (raw as any).message
          : [(raw as any)?.message ?? '서버 오류가 발생했습니다.'];

    res.status(status).json({
      statusCode: status,
      message,
    });
  }
}
