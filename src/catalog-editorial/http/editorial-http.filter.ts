import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

const statuses: Record<string, number> = {
  MALFORMED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
};
@Catch()
export class EditorialHttpFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    let error = 'INTERNAL_ERROR';
    if (exception instanceof HttpException) {
      error =
        Object.keys(statuses).find(
          (key) => statuses[key] === exception.getStatus(),
        ) ?? error;
    } else if (
      exception instanceof Error &&
      Object.hasOwn(statuses, exception.message)
    ) {
      error = exception.message;
    }
    const statusCode = statuses[error];
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.status(statusCode).json({ statusCode, error });
  }
}
