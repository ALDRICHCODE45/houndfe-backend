/**
 * Adapter from the common `resolve` command to the existing resolve use cases
 * (unit 3; contract §2.1, §12.6). Each one runs inside the caller's READ
 * COMMITTED transaction with its own `expectedVersion = 1` (R4) and the staff
 * Idempotency-Key as its `resolutionRequestId`, under `suppressLegacyClose`
 * because the application already closed the common requests.
 *
 * The old use cases' typed errors become the staff error envelope; anything
 * unknown is rethrown (500), never disguised.
 */
import { Inject, Injectable } from '@nestjs/common';
import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  DeliveryZoneError,
  type DeliveryZoneErrorCode,
} from '../../delivery-zones/domain/delivery-zone.repository';
import {
  APPROVE_DELIVERY_ZONE,
  DELIVERY_ZONE_VALIDATION_REPOSITORY,
  REJECT_DELIVERY_ZONE,
  type IDeliveryZoneValidationRepository,
} from '../../delivery-zones/domain/delivery-zone-validation.repository';
import {
  HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY,
  HumanDecisionReviewResolveError,
  type HumanDecisionReviewResolveErrorCode,
  type HumanDecisionReviewResolveResult,
  type ResolveHumanDecisionCommand,
} from '../../human-decisions/domain/human-decision-review-resolve.repository';
import { ReceiptReviewService } from '../../sales/review/receipt-review.service';
import {
  ChatbotRequestCommandError,
  type ChatbotRequestResolver,
  type WrappedResolveInput,
} from '../application/chatbot-request-commands.service';
import { ChatbotRequestWrapper } from './chatbot-request-wrapper';

/** The ambient-transaction entry point of the human-decision resolve use case. */
export interface AmbientHumanDecisionResolver {
  resolveInAmbientTransaction(
    command: ResolveHumanDecisionCommand,
  ): Promise<HumanDecisionReviewResolveResult>;
}

type SharedCode =
  | HumanDecisionReviewResolveErrorCode
  | DeliveryZoneErrorCode
  | 'DELIVERY_ZONE_VALIDATION_NOT_FOUND';

/** Shared mapping of the old error codes; `undefined` means "not mine". */
function mapCode(code: string): ChatbotRequestCommandError | undefined {
  switch (code as SharedCode) {
    case 'NOT_FOUND':
    case 'DELIVERY_ZONE_VALIDATION_NOT_FOUND':
      return new ChatbotRequestCommandError('NOT_FOUND', 404);
    case 'UNAUTHORIZED':
      return new ChatbotRequestCommandError('UNAUTHORIZED', 401);
    case 'FORBIDDEN':
      return new ChatbotRequestCommandError('FORBIDDEN', 403);
    case 'VERSION_CONFLICT':
      return new ChatbotRequestCommandError('VERSION_CONFLICT', 409);
    case 'IDEMPOTENCY_CONFLICT':
      return new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
    case 'ALREADY_RESOLVED':
      return new ChatbotRequestCommandError('REQUEST_CLOSED', 409);
    default:
      return undefined;
  }
}

function translate(error: unknown): Error {
  if (
    error instanceof HumanDecisionReviewResolveError ||
    error instanceof DeliveryZoneError
  ) {
    return mapCode(error.code) ?? error;
  }
  if (error instanceof BusinessRuleViolationError) {
    if (error.code === 'RECEIPT_NOT_ACTIONABLE') {
      return new ChatbotRequestCommandError('REQUEST_CLOSED', 409);
    }
    if (error.code === 'SALE_NOT_REVIEWABLE') {
      return new ChatbotRequestCommandError('ACTION_NOT_ALLOWED', 422);
    }
  }
  if (error instanceof InvalidArgumentError) {
    return new ChatbotRequestCommandError('VALIDATION_ERROR', 400);
  }
  return error instanceof Error ? error : new Error('resolve failed');
}

@Injectable()
export class WrappedRequestResolver implements ChatbotRequestResolver {
  constructor(
    @Inject(HUMAN_DECISION_REVIEW_RESOLVE_REPOSITORY)
    private readonly decisions: AmbientHumanDecisionResolver,
    @Inject(DELIVERY_ZONE_VALIDATION_REPOSITORY)
    private readonly validations: IDeliveryZoneValidationRepository,
    private readonly receipts: ReceiptReviewService,
    private readonly wrapper: ChatbotRequestWrapper,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async resolve(input: WrappedResolveInput): Promise<void> {
    try {
      await this.wrapper.suppressLegacyClose(() => this.dispatch(input));
    } catch (error) {
      throw translate(error);
    }
  }

  private async dispatch({
    row,
    action,
    actor,
    actorIsSuperAdmin,
    resolutionKey,
  }: WrappedResolveInput): Promise<void> {
    const who = { actorUserId: actor.userId, actorIsSuperAdmin };
    switch (action.type) {
      case 'PROVIDE_RESTOCK_ESTIMATE':
      case 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE':
      case 'PROVIDE_EXPIRATION_TEXT':
      case 'REPORT_EXPIRATION_UNAVAILABLE': {
        const base = {
          decisionId: this.required(row.humanDecisionId),
          expectedVersion: 1,
          resolutionRequestId: resolutionKey,
          ...who,
        };
        const { type, ...fields } = action;
        await this.decisions.resolveInAmbientTransaction({
          ...base,
          action: type,
          ...fields,
        } as ResolveHumanDecisionCommand);
        return;
      }
      case 'APPROVE_DELIVERY_ZONE':
      case 'REJECT_DELIVERY_ZONE': {
        const base = {
          validationId: await this.validationOf(row.deliveryZoneRequestId),
          expectedVersion: 1,
          resolutionRequestId: resolutionKey,
          ...who,
        };
        await this.validations.resolve(
          action.type === 'APPROVE_DELIVERY_ZONE'
            ? {
                ...base,
                action: APPROVE_DELIVERY_ZONE,
                settings: action.settings,
              }
            : { ...base, action: REJECT_DELIVERY_ZONE },
        );
        return;
      }
      case 'CONFIRM_RECEIPT':
      case 'REJECT_RECEIPT': {
        const receiptId = this.required(row.receiptEvidenceId);
        const saleId = await this.saleOf(receiptId);
        if (action.type === 'CONFIRM_RECEIPT') {
          await this.receipts.confirm(
            saleId,
            receiptId,
            actor.userId,
            { amountCents: action.amountCents },
            resolutionKey,
          );
        } else {
          await this.receipts.reject(saleId, receiptId, actor.userId, {
            reason: action.reason,
            customerReason: action.customerReason,
          });
        }
        return;
      }
    }
  }

  private required(id: string | null): string {
    if (id === null) throw new Error('wrapped request without its wrapped row');
    return id;
  }

  private async validationOf(requestId: string | null): Promise<string> {
    const row = await this.tenantPrisma
      .getClient()
      .deliveryZoneRequest.findFirst({
        where: {
          id: this.required(requestId),
          tenantId: this.tenantPrisma.getTenantId(),
        },
        select: { validationId: true },
      });
    if (!row?.validationId) {
      throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    }
    return row.validationId;
  }

  private async saleOf(receiptId: string): Promise<string> {
    const row = await this.tenantPrisma.getClient().receiptEvidence.findFirst({
      where: { id: receiptId, tenantId: this.tenantPrisma.getTenantId() },
      select: { saleId: true },
    });
    if (!row) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    return row.saleId;
  }
}
