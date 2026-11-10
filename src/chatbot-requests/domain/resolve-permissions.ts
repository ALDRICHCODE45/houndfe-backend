/**
 * Owner decision (unit 3 follow-up): `POST /chatbot-requests/:id/resolve`
 * needs `read` + `update:ChatbotRequest` AND the permission the old route of
 * the wrapped subtype always required, so moving the screen to the common
 * inbox grants nobody a power they did not have before.
 *
 *   RESTOCK / EXPIRATION  update:HumanDecision
 *   DELIVERY_ZONE         validate:DeliveryZone
 *   TRANSFER_RECEIPT      update:ReceiptEvidence
 *
 * One helper for the resolve command and for unit 4's `allowedActions`
 * (`RESOLVE` is offered only when `canResolveSubtype` is true).
 */
import type {
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import type { ChatbotRequestSubtype } from './chatbot-request.commands';

export type LegacyResolvePermission = readonly [AppActions, AppSubjects];

const LEGACY_RESOLVE: Partial<
  Record<ChatbotRequestSubtype, LegacyResolvePermission>
> = {
  RESTOCK: ['update', 'HumanDecision'],
  EXPIRATION: ['update', 'HumanDecision'],
  DELIVERY_ZONE: ['validate', 'DeliveryZone'],
  TRANSFER_RECEIPT: ['update', 'ReceiptEvidence'],
};

/** `null` for a subtype with no wrapped resolve (it never resolves here). */
export function legacyResolvePermission(
  subtype: ChatbotRequestSubtype,
): LegacyResolvePermission | null {
  return LEGACY_RESOLVE[subtype] ?? null;
}

/** The caller's CASL ability (`req.ability`) or anything shaped like it. */
export interface PermissionCheck {
  can(action: AppActions, subject: AppSubjects): boolean;
}

export function canResolveSubtype(
  ability: PermissionCheck,
  subtype: ChatbotRequestSubtype,
): boolean {
  const permission = legacyResolvePermission(subtype);
  return permission !== null && ability.can(permission[0], permission[1]);
}
