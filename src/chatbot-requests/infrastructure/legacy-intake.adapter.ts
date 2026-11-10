/**
 * Runs today's intake for a wrapped subtype (RESTOCK, EXPIRATION,
 * DELIVERY_ZONE) with the parsers and repositories the old route uses, so the
 * unit-3 hooks wrap the result and nothing about those flows is duplicated
 * (S4, contract §3.2). The old route's own checks stay here: the body goes
 * through the same exact parser or validation pipe, and every error of the
 * three repositories becomes the staff/bot error envelope.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  DELIVERY_ZONE_BOT_REPOSITORY,
  DeliveryZoneIntakeError,
  type IDeliveryZoneBotRepository,
} from '../../delivery-zones/domain/delivery-zone-bot.repository';
import { parseDeliveryZoneIntakeRequest } from '../../delivery-zones/domain/delivery-zone-intake.request';
import { toBotDeliveryZoneResponse } from '../../delivery-zones/presentation/dto/bot-delivery-zone.response';
import {
  EXPIRATION_INTAKE_REPOSITORY,
  ExpirationIntakeError,
  type IExpirationIntakeRepository,
} from '../../human-decisions/domain/expiration-intake.repository';
import { parseExpirationIntakeRequest } from '../../human-decisions/domain/expiration-intake.request';
import {
  RESTOCK_INTAKE_REPOSITORY,
  RestockIntakeError,
  type IRestockIntakeRepository,
} from '../../human-decisions/domain/restock-intake.repository';
import { toBotExpirationIntakeResponse } from '../../human-decisions/presentation/dto/bot-expiration-intake.response';
import { toBotRestockIntakeResponse } from '../../human-decisions/presentation/dto/bot-restock-intake.response';
import { RestockIntakeRequestDto } from '../../human-decisions/presentation/dto/restock-intake.request';
import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import type {
  LegacyIntakePort,
  LegacyIntakeResult,
} from '../application/bot-request-intake.service';
import { ChatbotRequestCommandError } from '../application/chatbot-request-commands.service';
import type { WrappedSubtype } from '../domain/bot-request-envelope';

const LEGACY_ERRORS: Record<string, 400 | 404 | 409> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  VERSION_CONFLICT: 409,
};

@Injectable()
export class LegacyIntakeAdapter implements LegacyIntakePort {
  constructor(
    @Inject(RESTOCK_INTAKE_REPOSITORY)
    private readonly restock: IRestockIntakeRepository,
    @Inject(EXPIRATION_INTAKE_REPOSITORY)
    private readonly expiration: IExpirationIntakeRepository,
    @Optional()
    @Inject(DELIVERY_ZONE_BOT_REPOSITORY)
    private readonly zone?: IDeliveryZoneBotRepository,
  ) {}

  async submit(
    subtype: WrappedSubtype,
    detail: Record<string, unknown>,
    credentialId: string,
  ): Promise<LegacyIntakeResult> {
    try {
      switch (subtype) {
        case 'RESTOCK':
          return await this.submitRestock(detail, credentialId);
        case 'EXPIRATION':
          return await this.submitExpiration(detail, credentialId);
        case 'DELIVERY_ZONE':
          return await this.submitZone(detail, credentialId);
      }
    } catch (error) {
      if (
        error instanceof RestockIntakeError ||
        error instanceof ExpirationIntakeError ||
        error instanceof DeliveryZoneIntakeError
      ) {
        const status = LEGACY_ERRORS[error.code];
        if (status) {
          throw new ChatbotRequestCommandError(
            error.code as 'NOT_FOUND',
            status,
          );
        }
      }
      throw error;
    }
  }

  private async submitRestock(
    detail: Record<string, unknown>,
    credentialId: string,
  ): Promise<LegacyIntakeResult> {
    const body = (await createAppValidationPipe().transform(detail, {
      type: 'body',
      metatype: RestockIntakeRequestDto,
    })) as RestockIntakeRequestDto;
    const result = await this.restock.submit({
      sourceRequestId: body.sourceRequestId,
      productId: body.productId,
      productName: body.productName,
      variantId: body.variantId ?? null,
      sku: body.sku ?? null,
      requestedQuantity: body.requestedQuantity ?? null,
      observedStockAtRequest: body.observedStockAtRequest ?? null,
      stockObservedAt: body.stockObservedAt ?? null,
      supersedesDecisionId: body.supersedesDecisionId ?? null,
      submittedCredentialId: credentialId,
    });
    return {
      status: result.status === 'created' ? 'created' : 'replayed',
      wrappedId: result.request.id,
      projection: toBotRestockIntakeResponse(result.request),
    };
  }

  private async submitExpiration(
    detail: Record<string, unknown>,
    credentialId: string,
  ): Promise<LegacyIntakeResult> {
    const parsed = parseExpirationIntakeRequest(detail);
    const result = await this.expiration.submit({
      sourceRequestId: parsed.sourceRequestId,
      type: parsed.type,
      productId: parsed.productId,
      variantId: parsed.variantId,
      submittedCredentialId: credentialId,
    });
    return {
      status: result.status === 'created' ? 'created' : 'replayed',
      wrappedId: result.request.id,
      projection: toBotExpirationIntakeResponse(result.request),
    };
  }

  private async submitZone(
    detail: Record<string, unknown>,
    credentialId: string,
  ): Promise<LegacyIntakeResult> {
    if (!this.zone) throw new Error('Delivery-zone intake is not wired');
    const result = await this.zone.submit({
      request: parseDeliveryZoneIntakeRequest(detail, new Date()),
      submittedCredentialId: credentialId,
    });
    return {
      status: result.status === 'created' ? 'created' : 'replayed',
      wrappedId: result.record.id,
      projection: toBotDeliveryZoneResponse(result.record),
    };
  }
}
