import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = this.getHttpStatus(exception.code);
    const message = this.getMessage(exception.code);

    if (status === HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(`[${exception.code}] ${exception.message}`);
    } else {
      this.logger.warn(`[${exception.code}] ${exception.message}`);
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  private getHttpStatus(code: string): number {
    switch (code) {
      case 'P2025':
        return HttpStatus.NOT_FOUND;
      case 'P2002':
        return HttpStatus.CONFLICT;
      case 'P2003':
        return HttpStatus.BAD_REQUEST;
      default:
        return HttpStatus.INTERNAL_SERVER_ERROR;
    }
  }

  private getMessage(code: string): string {
    switch (code) {
      case 'P2025':
        return 'Resource not found';
      case 'P2002':
        return 'Unique constraint violation';
      case 'P2003':
        return 'Invalid relation reference';
      default:
        return 'Internal server error';
    }
  }
}
