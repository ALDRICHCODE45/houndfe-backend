/**
 * HD-03a — HumanDecisionHttpFilter spec.
 *
 * Asserts the EXACT `{statusCode, code, message}` envelope, the status/code
 * mapping, header preservation for the guard rate-limit path and that no
 * upstream message, stack, raw validation array or payload value leaks.
 * Uses a fake `ArgumentsHost`/response; no Nest app or DB is involved.
 */
import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  InsufficientPermissionsError,
  InvalidArgumentError,
} from '../../../shared/domain/domain-error';
import { HumanDecisionReviewResolveError } from '../../domain/human-decision-review-resolve.repository';
import { RestockIntakeError } from '../../domain/restock-intake.repository';
import {
  HumanDecisionHttpFilter,
  type HumanDecisionErrorBody,
} from './human-decision-http.filter';

interface FakeHttpResponse {
  statusCode: number | null;
  body: HumanDecisionErrorBody | null;
  headers: Record<string, string>;
  status: jest.Mock;
  json: jest.Mock;
  setHeader: jest.Mock;
  removeHeader: jest.Mock;
}

function makeResponse(): FakeHttpResponse {
  const response: FakeHttpResponse = {
    statusCode: null,
    body: null,
    headers: {},
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
    removeHeader: jest.fn(),
  };

  response.status.mockImplementation((code: number) => {
    response.statusCode = code;
    return { json: response.json };
  });
  response.json.mockImplementation((body: HumanDecisionErrorBody) => {
    response.body = body;
  });
  response.setHeader.mockImplementation((name: string, value: string) => {
    response.headers[name] = value;
  });
  response.removeHeader.mockImplementation((name: string) => {
    delete response.headers[name];
  });

  return response;
}

function makeHost(response: FakeHttpResponse): ArgumentsHost {
  return {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

function run(exception: unknown, response = makeResponse()): FakeHttpResponse {
  new HumanDecisionHttpFilter().catch(exception, makeHost(response));
  return response;
}

function expectEnvelope(
  response: FakeHttpResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  expect(response.statusCode).toBe(statusCode);
  expect(response.body).toEqual({ statusCode, code, message });
  expect(Object.keys(response.body as object).sort()).toEqual([
    'code',
    'message',
    'statusCode',
  ]);
}

describe('HumanDecisionHttpFilter', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps RestockIntakeError NOT_FOUND to 404 without echoing the message', () => {
    const response = run(
      new RestockIntakeError(
        'NOT_FOUND',
        'internal detail: decision abc missing',
      ),
    );

    expectEnvelope(response, HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    expect(JSON.stringify(response.body)).not.toContain('internal detail');
  });

  it('maps IDEMPOTENCY_CONFLICT to 409 with its own sanitized code', () => {
    const response = run(
      new RestockIntakeError('IDEMPOTENCY_CONFLICT', 'hash mismatch for xyz'),
    );

    expectEnvelope(
      response,
      HttpStatus.CONFLICT,
      'IDEMPOTENCY_CONFLICT',
      'Request conflicts with a previous submission',
    );
    expect(JSON.stringify(response.body)).not.toContain('hash mismatch');
  });

  it('maps VERSION_CONFLICT to 409 with its own sanitized code', () => {
    const response = run(
      new RestockIntakeError('VERSION_CONFLICT', 'predecessor is UNKNOWN'),
    );

    expectEnvelope(
      response,
      HttpStatus.CONFLICT,
      'VERSION_CONFLICT',
      'Human decision was modified by another reviewer',
    );
    expect(JSON.stringify(response.body)).not.toContain('UNKNOWN');
  });

  it('maps the HD-02a canonicalizer InvalidArgumentError to 400 VALIDATION_ERROR', () => {
    const response = run(
      new InvalidArgumentError(
        'productId must be a valid UUID',
        'INVALID_RESTOCK_REQUEST',
      ),
    );

    expectEnvelope(
      response,
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Invalid request',
    );
    expect(JSON.stringify(response.body)).not.toContain('must be a valid UUID');
  });

  it('maps a ValidationPipe BadRequestException (raw array) to a sanitized 400', () => {
    const response = run(
      new BadRequestException([
        'tenantId should not exist',
        'source should not exist',
      ]),
    );

    expectEnvelope(
      response,
      HttpStatus.BAD_REQUEST,
      'VALIDATION_ERROR',
      'Invalid request',
    );
    expect(JSON.stringify(response.body)).not.toContain('tenantId');
    expect(JSON.stringify(response.body)).not.toContain('source');
  });

  it('maps the guard ForbiddenException to 403 FORBIDDEN', () => {
    const response = run(new ForbiddenException('Insufficient service scope'));

    expectEnvelope(response, HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Forbidden');
    expect(JSON.stringify(response.body)).not.toContain(
      'Insufficient service scope',
    );
  });

  it('maps UnauthorizedException to 401 UNAUTHORIZED', () => {
    const response = run(
      new UnauthorizedException('Invalid service credential'),
    );

    expectEnvelope(
      response,
      HttpStatus.UNAUTHORIZED,
      'UNAUTHORIZED',
      'Unauthorized',
    );
    expect(JSON.stringify(response.body)).not.toContain(
      'Invalid service credential',
    );
  });

  it('maps the guard rate-limit 429 to RATE_LIMITED and preserves Retry-After', () => {
    const response = makeResponse();
    // The guard sets this before throwing; the filter must not clobber it.
    response.headers['Retry-After'] = '7';

    new HumanDecisionHttpFilter().catch(
      new HttpException(
        'Service credential rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      ),
      makeHost(response),
    );

    expectEnvelope(
      response,
      HttpStatus.TOO_MANY_REQUESTS,
      'RATE_LIMITED',
      'Too many requests',
    );
    expect(response.headers['Retry-After']).toBe('7');
    expect(response.removeHeader).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain('rate limit exceeded');
  });

  it('maps an unrelated Error to a generic 500 with no message/stack/timestamp', () => {
    const response = run(new Error('pg password leaked: hunter2'));

    expectEnvelope(
      response,
      HttpStatus.INTERNAL_SERVER_ERROR,
      'INTERNAL_ERROR',
      'Internal server error',
    );
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
    expect(response.body).not.toHaveProperty('timestamp');
    expect(response.body).not.toHaveProperty('error');
  });

  it('retains the status and sanitizes an unmapped HttpException', () => {
    const response = run(new HttpException('upstream secret detail', 418));

    expectEnvelope(response, 418, 'REQUEST_ERROR', 'Request failed');
    expect(JSON.stringify(response.body)).not.toContain(
      'upstream secret detail',
    );
  });

  it('maps an HttpException 500 to INTERNAL_ERROR at its original status without leaking', () => {
    const response = run(
      new InternalServerErrorException('pg pool exhausted: hunter2'),
    );

    expectEnvelope(
      response,
      HttpStatus.INTERNAL_SERVER_ERROR,
      'INTERNAL_ERROR',
      'Internal server error',
    );
    expect(JSON.stringify(response.body)).not.toContain('hunter2');
    expect(JSON.stringify(response.body)).not.toContain('pg pool');
    expect(response.body).not.toHaveProperty('timestamp');
    expect(response.body).not.toHaveProperty('error');
  });

  it('maps an HttpException 503 to INTERNAL_ERROR at its original status without leaking', () => {
    const response = run(
      new ServiceUnavailableException('upstream provider token abc123'),
    );

    expectEnvelope(
      response,
      HttpStatus.SERVICE_UNAVAILABLE,
      'INTERNAL_ERROR',
      'Internal server error',
    );
    expect(JSON.stringify(response.body)).not.toContain('abc123');
    expect(JSON.stringify(response.body)).not.toContain('upstream provider');
    expect(response.body).not.toHaveProperty('timestamp');
    expect(response.body).not.toHaveProperty('error');
  });

  it('sanitizes NestJS NotFoundException to 404 NOT_FOUND', () => {
    const response = run(new NotFoundException('Decision abc missing'));

    expectEnvelope(response, HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');
    expect(JSON.stringify(response.body)).not.toContain('Decision abc missing');
  });

  it('sanitizes NestJS ConflictException to 409 CONFLICT', () => {
    const response = run(new ConflictException('duplicate key row'));

    expectEnvelope(
      response,
      HttpStatus.CONFLICT,
      'CONFLICT',
      'Request conflict',
    );
    expect(JSON.stringify(response.body)).not.toContain('duplicate key row');
  });

  describe('HD-04d0 human review GET/resolve mappings', () => {
    it.each([
      ['NOT_FOUND', HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found'],
      ['UNAUTHORIZED', HttpStatus.UNAUTHORIZED, 'UNAUTHORIZED', 'Unauthorized'],
      ['FORBIDDEN', HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Forbidden'],
      [
        'VERSION_CONFLICT',
        HttpStatus.CONFLICT,
        'VERSION_CONFLICT',
        'Human decision was modified by another reviewer',
      ],
      [
        'IDEMPOTENCY_CONFLICT',
        HttpStatus.CONFLICT,
        'IDEMPOTENCY_CONFLICT',
        'Request conflicts with a previous submission',
      ],
      [
        'ALREADY_RESOLVED',
        HttpStatus.CONFLICT,
        'ALREADY_RESOLVED',
        'Human decision was already resolved',
      ],
    ] as const)(
      'maps HumanDecisionReviewResolveError %s to %s %s without echoing the message',
      (errorCode, statusCode, code, message) => {
        const sentinel = `SENTINEL-${errorCode}-7c41e9d2-uuid-credential`;
        const response = run(
          new HumanDecisionReviewResolveError(
            errorCode,
            `leaked ${sentinel} and reviewer PII jane.doe@example.com`,
          ),
        );

        expectEnvelope(response, statusCode, code, message);
        expect(JSON.stringify(response.body)).not.toContain(sentinel);
        expect(JSON.stringify(response.body)).not.toContain(
          'jane.doe@example.com',
        );
        expect(response.body).not.toHaveProperty('timestamp');
        expect(response.body).not.toHaveProperty('error');
      },
    );

    it('fails closed to a value-free 500 for an unexpected resolve code at runtime', () => {
      const sentinel = 'SENTINEL-unknown-code-5d1a8b';
      const response = run(
        new HumanDecisionReviewResolveError(
          'SOMETHING_NEW' as 'NOT_FOUND',
          `leaked ${sentinel}`,
        ),
      );

      expectEnvelope(
        response,
        HttpStatus.INTERNAL_SERVER_ERROR,
        'INTERNAL_ERROR',
        'Internal server error',
      );
      expect(JSON.stringify(response.body)).not.toContain(sentinel);
    });

    it('maps the real PermissionsGuard InsufficientPermissionsError to 403 FORBIDDEN', () => {
      const response = run(new InsufficientPermissionsError());

      expectEnvelope(response, HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Forbidden');
      expect(JSON.stringify(response.body)).not.toContain(
        'Insufficient permissions',
      );
      expect(response.body).not.toHaveProperty('timestamp');
      expect(response.body).not.toHaveProperty('error');
    });

    it('maps the global listing factory raw BadRequestException ValidationErrors to a value-free 400', () => {
      const valueSentinel = 'SENTINEL-listing-value-3b8d1f';
      const targetSentinel = 'SENTINEL-listing-target-9a4c7e';
      const response = run(
        new BadRequestException([
          {
            property: 'status',
            value: valueSentinel,
            target: { [targetSentinel]: true },
            constraints: { isIn: 'status must be PENDING' },
          },
        ]),
      );

      expectEnvelope(
        response,
        HttpStatus.BAD_REQUEST,
        'VALIDATION_ERROR',
        'Invalid request',
      );
      expect(JSON.stringify(response.body)).not.toContain(valueSentinel);
      expect(JSON.stringify(response.body)).not.toContain(targetSentinel);
      expect(JSON.stringify(response.body)).not.toContain('must be PENDING');
      expect(response.body).not.toHaveProperty('timestamp');
      expect(response.body).not.toHaveProperty('error');
    });
  });
});
