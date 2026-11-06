import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { EditorialPublicationNotReadyError } from '../application/editorial-publish-writer';
import { EditorialStateUnreadableError } from '../application/editorial-recorded-state-v2';
import { EditorialVocabularyUnrepresentableError } from '../application/editorial-vocabulary-read';

const statuses: Record<string, number> = {
  MALFORMED: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_ERROR: 500,
  VOCABULARY_CHANGED: 409,
};
// Typed failures: mapped from their error class only, never from a message.
const typed: Record<string, number> = {
  EDITORIAL_VOCABULARY_UNREPRESENTABLE: 500,
  EDITORIAL_STATE_UNREADABLE: 409,
};
@Catch()
export class EditorialHttpFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    let error = 'INTERNAL_ERROR';
    if (exception instanceof EditorialVocabularyUnrepresentableError) {
      error = 'EDITORIAL_VOCABULARY_UNREPRESENTABLE';
    } else if (exception instanceof EditorialStateUnreadableError) {
      error = 'EDITORIAL_STATE_UNREADABLE';
    } else if (exception instanceof HttpException) {
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
    const statusCode = statuses[error] ?? typed[error] ?? 500;
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Editorial-Contract-Version', '2');
    response.removeHeader('Editorial-Vocabulary-Revision');
    // D2: an unready publish names what blocks it, with the readiness items.
    if (exception instanceof EditorialPublicationNotReadyError) {
      const { items, bySection } = exception.readiness;
      response.status(400).json({
        statusCode: 400,
        error: 'MALFORMED',
        items,
        bySection,
      });
      return;
    }
    response.status(statusCode).json({ statusCode, error });
  }
}
