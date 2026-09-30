/**
 * HD-03b2 — `POST /chatbot-api/human-decisions` (bot RESTOCK intake).
 *
 * Contract (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
 * HD-EXP-03 adds the EXPIRATION intake on the SAME route; the contract for
 * that body is
 * `houndfe-chatbot-human-decisions/docs/human-decisions-expiration-v1.md`.
 *
 * This is a NEW, separate controller so the existing `ChatbotApiController`
 * routes and their audit interceptor stay untouched. Boundaries:
 *   - The body is validated by the committed `RestockIntakeRequestDto`; it can
 *     never carry tenant, source, branch, credential or customer authority.
 *   - `ServiceAuthGuard` supplies the trusted tenant (via CLS) and sets
 *     `request.serviceCredential`; the controller reads only the credential
 *     `id` for the immutable audit column and fails closed when it is absent.
 *   - `X-Idempotency-Key` MUST equal the body `sourceRequestId` (exact match)
 *     BEFORE the repository is invoked.
 *   - The repository derives the tenant from CLS, so no tenant is ever passed
 *     in the `submit` payload.
 *   - The response is ALWAYS the immutable historical receipt from
 *     `toBotRestockIntakeResponse` / `toBotExpirationIntakeResponse`: HTTP 201
 *     on first create, HTTP 200 on an exact replay, with BOTH bodies identical
 *     even after the row is RESOLVED.
 *
 * ONE ROUTE, TWO TYPES (HD-EXP-03). `@Body()` is typed `unknown` so Nest's
 * global pipe sees metatype `Object` and skips validation; the controller then
 * dispatches on the discriminant read from an OWN ENUMERABLE DATA descriptor
 * (never a getter or a Proxy `get` trap). `EXPIRATION` goes to the exact
 * parser `parseExpirationIntakeRequest`; every other body goes to the RESTOCK
 * path, which re-runs `createAppValidationPipe()` — the SAME pipe factory
 * `main.ts` installs — against `RestockIntakeRequestDto`, so RESTOCK
 * validation is byte-for-byte the previous global behavior. No other route,
 * query, poll, resolve or ACK behavior changes.
 *
 * `@UseFilters(HumanDecisionHttpFilter)` is controller-scoped so every thrown
 * value — guard, pipe, parser or repository — is reduced to the sanitized
 * `{statusCode, code, message}` envelope, overriding the global filters.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequiredScopes } from '../../chatbot-api/presentation/decorators/required-scopes.decorator';
import { ServiceAuthGuard } from '../../chatbot-api/presentation/guards/service-auth.guard';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import {
  EXPIRATION_INTAKE_REPOSITORY,
  type IExpirationIntakeRepository,
} from '../domain/expiration-intake.repository';
import {
  EXPIRATION_TYPE,
  parseExpirationIntakeRequest,
} from '../domain/expiration-intake.request';
import {
  RESTOCK_INTAKE_REPOSITORY,
  type IRestockIntakeRepository,
} from '../domain/restock-intake.repository';
import {
  toBotExpirationIntakeResponse,
  type BotExpirationIntakeResponse,
} from './dto/bot-expiration-intake.response';
import {
  toBotRestockIntakeResponse,
  type BotRestockIntakeResponse,
} from './dto/bot-restock-intake.response';
import { RestockIntakeRequestDto } from './dto/restock-intake.request';
import { HumanDecisionHttpFilter } from './filters/human-decision-http.filter';

const IDEMPOTENCY_HEADER = 'x-idempotency-key';

/** Canonical RFC 4122 UUID shape (v1-v8, variant 8/9/a/b); mirrors HD-02a. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Minimal trusted view of the request the guard decorated. */
interface ServiceAuthenticatedRequest extends Request {
  serviceCredential?: { id: string };
}

/** Untrusted `type` discriminant read safely, or `undefined` when unreadable. */
type IntakeTypeDiscriminant = string | undefined;

/**
 * Read the `type` discriminant WITHOUT invoking a getter or Proxy `get` trap:
 * only an own, enumerable, DATA descriptor whose value is a string counts. A
 * missing, accessor, symbol-keyed or non-string value falls through to the
 * RESTOCK path, which rejects it with the same sanitized 400 as before.
 */
function readIntakeType(value: unknown): IntakeTypeDiscriminant {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
  if (
    descriptor === undefined ||
    !('value' in descriptor) ||
    descriptor.enumerable !== true ||
    typeof descriptor.value !== 'string'
  ) {
    return undefined;
  }

  return descriptor.value;
}

@Controller('chatbot-api/human-decisions')
@UseGuards(ServiceAuthGuard)
@UseFilters(HumanDecisionHttpFilter)
export class BotRestockIntakeController {
  constructor(
    @Inject(RESTOCK_INTAKE_REPOSITORY)
    private readonly intakeRepository: IRestockIntakeRepository,
    @Inject(EXPIRATION_INTAKE_REPOSITORY)
    private readonly expirationIntakeRepository: IExpirationIntakeRepository,
  ) {}

  @Post()
  @RequiredScopes('human-decisions:create')
  async create(
    @Body() rawBody: unknown,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Req() request: ServiceAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BotRestockIntakeResponse | BotExpirationIntakeResponse> {
    const submittedCredentialId = request.serviceCredential?.id;
    if (!submittedCredentialId) {
      // The guard always sets this; a missing value means the trusted
      // credential context was lost, so deny rather than persist an untrusted
      // audit identity.
      throw new UnauthorizedException('Service credential context required');
    }

    if (readIntakeType(rawBody) === EXPIRATION_TYPE) {
      return this.createExpiration(
        rawBody,
        idempotencyKey,
        submittedCredentialId,
        response,
      );
    }

    return this.createRestock(
      rawBody,
      idempotencyKey,
      submittedCredentialId,
      response,
    );
  }

  /**
   * RESTOCK path: the untrusted body is re-validated with the production pipe
   * factory against `RestockIntakeRequestDto`, exactly as the global pipe did
   * before this route accepted a second discriminant.
   */
  private async createRestock(
    rawBody: unknown,
    idempotencyKey: string | undefined,
    submittedCredentialId: string,
    response: Response,
  ) {
    const body = (await createAppValidationPipe().transform(rawBody, {
      type: 'body',
      metatype: RestockIntakeRequestDto,
    })) as RestockIntakeRequestDto;

    this.assertIdempotencyKeyMatches(idempotencyKey, body.sourceRequestId);

    const result = await this.intakeRepository.submit({
      sourceRequestId: body.sourceRequestId,
      productId: body.productId,
      productName: body.productName,
      variantId: body.variantId ?? null,
      sku: body.sku ?? null,
      requestedQuantity: body.requestedQuantity ?? null,
      observedStockAtRequest: body.observedStockAtRequest ?? null,
      stockObservedAt: body.stockObservedAt ?? null,
      supersedesDecisionId: body.supersedesDecisionId ?? null,
      submittedCredentialId,
    });

    response.status(
      result.status === 'created' ? HttpStatus.CREATED : HttpStatus.OK,
    );

    return toBotRestockIntakeResponse(result.request);
  }

  /**
   * EXPIRATION path: the exact four-key body is parsed by
   * `parseExpirationIntakeRequest` (any failure is a sanitized 400), and the
   * idempotency header must LITERALLY equal the RETAINED original
   * `sourceRequestId` bytes — a header that only matches after canonicalizing
   * the UUID casing is rejected.
   */
  private async createExpiration(
    rawBody: unknown,
    idempotencyKey: string | undefined,
    submittedCredentialId: string,
    response: Response,
  ): Promise<BotExpirationIntakeResponse> {
    const parsed = parseExpirationIntakeRequest(rawBody);

    this.assertIdempotencyKeyMatches(
      idempotencyKey,
      parsed.originalSourceRequestId,
    );

    const result = await this.expirationIntakeRepository.submit({
      sourceRequestId: parsed.sourceRequestId,
      type: parsed.type,
      productId: parsed.productId,
      variantId: parsed.variantId,
      submittedCredentialId,
    });

    response.status(
      result.status === 'created' ? HttpStatus.CREATED : HttpStatus.OK,
    );

    return toBotExpirationIntakeResponse(result.request);
  }

  /**
   * Rejects a missing, non-UUID or non-matching idempotency header with a
   * sanitized `400 VALIDATION_ERROR` before any repository call. The value is
   * compared LITERALLY: no trimming or normalization is applied, so a header
   * padded with surrounding whitespace is rejected even though `UUID_PATTERN`
   * would otherwise accept the trimmed form. The body `sourceRequestId` is
   * already UUID-validated by the global pipe, so an exact match also
   * guarantees the header is a canonical UUID.
   */
  private assertIdempotencyKeyMatches(
    idempotencyKey: string | undefined,
    sourceRequestId: string,
  ): void {
    if (
      typeof idempotencyKey !== 'string' ||
      !UUID_PATTERN.test(idempotencyKey) ||
      idempotencyKey !== sourceRequestId
    ) {
      throw new BadRequestException(
        'X-Idempotency-Key must match sourceRequestId',
      );
    }
  }
}
