import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
} from '@nestjs/common';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import { ChatbotRequestHttpFilter } from './chatbot-request-http.filter';

function run(exception: unknown) {
  const headers: Record<string, string> = {};
  const json = jest.fn<void, [Record<string, unknown>]>();
  const status = jest.fn<{ json: typeof json }, [number]>(() => ({ json }));
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
      return response;
    },
    status,
  };
  new ChatbotRequestHttpFilter().catch(exception, {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost);
  return {
    headers,
    status: status.mock.calls[0][0],
    body: json.mock.calls[0][0],
  };
}

describe('ChatbotRequestHttpFilter (bot intake codes)', () => {
  it('adds the extra fields of an error to the body', () => {
    const { status, body, headers } = run(
      new ChatbotRequestCommandError('CUSTOMER_OPEN_LIMIT', 409, undefined, {
        limit: 20,
        open: 20,
      }),
    );

    expect(status).toBe(409);
    expect(body).toEqual({
      statusCode: 409,
      code: 'CUSTOMER_OPEN_LIMIT',
      message: 'The customer has too many open requests',
      limit: 20,
      open: 20,
    });
    expect(headers['Cache-Control']).toBe('no-store');
  });

  it('moves retryAfterSeconds into the Retry-After header', () => {
    const { status, body, headers } = run(
      new ChatbotRequestCommandError('CUSTOMER_RATE_LIMITED', 429, undefined, {
        limit: 10,
        retryAfterSeconds: 90,
      }),
    );

    expect(status).toBe(429);
    expect(headers['Retry-After']).toBe('90');
    expect(body).toMatchObject({ code: 'CUSTOMER_RATE_LIMITED', limit: 10 });
    expect(body).not.toHaveProperty('retryAfterSeconds');
  });

  it('names the guard errors the contract names', () => {
    expect(
      run(new ForbiddenException('Insufficient service scope')).body,
    ).toMatchObject({ statusCode: 403, code: 'INSUFFICIENT_SCOPE' });
    expect(run(new ForbiddenException('Other')).body).toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(
      run(new HttpException('limit', HttpStatus.TOO_MANY_REQUESTS)).body,
    ).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
  });

  it('keeps SUBTYPE_DISABLED and SCHEDULING_DISABLED as 422', () => {
    expect(
      run(new ChatbotRequestCommandError('SUBTYPE_DISABLED', 422)).body,
    ).toMatchObject({ statusCode: 422, code: 'SUBTYPE_DISABLED' });
    expect(
      run(new ChatbotRequestCommandError('SCHEDULING_DISABLED', 422)).body,
    ).toMatchObject({ statusCode: 422, code: 'SCHEDULING_DISABLED' });
  });
});
