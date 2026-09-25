/**
 * HD-03b2 — `POST /chatbot-api/human-decisions` (bot RESTOCK intake).
 *
 * Contract (read-only):
 * `houndfe-chatbot-human-decisions/docs/human-decisions-contract-v1.md`.
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
 *     `toBotRestockIntakeResponse`: HTTP 201 on first create, HTTP 200 on an
 *     exact replay, with BOTH bodies identical even after the row is RESOLVED.
 *
 * `@UseFilters(HumanDecisionHttpFilter)` is controller-scoped so every thrown
 * value — guard, pipe or repository — is reduced to the sanitized
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
import {
  RESTOCK_INTAKE_REPOSITORY,
  type IRestockIntakeRepository,
} from '../domain/restock-intake.repository';
import { toBotRestockIntakeResponse } from './dto/bot-restock-intake.response';
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

@Controller('chatbot-api/human-decisions')
@UseGuards(ServiceAuthGuard)
@UseFilters(HumanDecisionHttpFilter)
export class BotRestockIntakeController {
  constructor(
    @Inject(RESTOCK_INTAKE_REPOSITORY)
    private readonly intakeRepository: IRestockIntakeRepository,
  ) {}

  @Post()
  @RequiredScopes('human-decisions:create')
  async create(
    @Body() body: RestockIntakeRequestDto,
    @Headers(IDEMPOTENCY_HEADER) idempotencyKey: string | undefined,
    @Req() request: ServiceAuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const submittedCredentialId = request.serviceCredential?.id;
    if (!submittedCredentialId) {
      // The guard always sets this; a missing value means the trusted
      // credential context was lost, so deny rather than persist an untrusted
      // audit identity.
      throw new UnauthorizedException('Service credential context required');
    }

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
