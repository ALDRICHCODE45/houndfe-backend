/**
 * DOMAIN UNIT SPEC: the permission each wrapped subtype needs on top of
 * `read` + `update:ChatbotRequest` (owner decision, unit 3 follow-up).
 */
import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import type { ChatbotRequestSubtype } from './chatbot-request.commands';
import {
  canResolveSubtype,
  legacyResolvePermission,
} from './resolve-permissions';

function ability(grants: [AppActions, AppSubjects][]): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const [action, subject] of grants) can(action, subject);
  return build();
}

const cashier = ability([
  ['read', 'ChatbotRequest'],
  ['update', 'ChatbotRequest'],
]);
const manager = ability([
  ['read', 'ChatbotRequest'],
  ['update', 'ChatbotRequest'],
  ['update', 'HumanDecision'],
  ['validate', 'DeliveryZone'],
]);
const managerWithReceipts = ability([
  ['read', 'ChatbotRequest'],
  ['update', 'ChatbotRequest'],
  ['update', 'HumanDecision'],
  ['validate', 'DeliveryZone'],
  ['update', 'ReceiptEvidence'],
]);
const superAdmin = ability([['manage', 'all']]);

describe('legacyResolvePermission', () => {
  it.each([
    ['RESTOCK', ['update', 'HumanDecision']],
    ['EXPIRATION', ['update', 'HumanDecision']],
    ['DELIVERY_ZONE', ['validate', 'DeliveryZone']],
    ['TRANSFER_RECEIPT', ['update', 'ReceiptEvidence']],
  ] as const)('%s needs %j', (subtype, permission) => {
    expect(legacyResolvePermission(subtype)).toEqual(permission);
  });

  it.each([
    'TALK_TO_HUMAN',
    'COMPLAINT',
    'UNKNOWN_QUESTION',
    'DISCOUNT',
  ] as const)(
    '%s has no wrapped resolve, so no permission opens it',
    (subtype) => {
      expect(legacyResolvePermission(subtype)).toBeNull();
      expect(canResolveSubtype(superAdmin, subtype)).toBe(false);
    },
  );
});

describe('canResolveSubtype', () => {
  const decisions: ChatbotRequestSubtype[] = [
    'RESTOCK',
    'EXPIRATION',
    'DELIVERY_ZONE',
    'TRANSFER_RECEIPT',
  ];

  it('denies a Cashier-like ability on every subtype', () => {
    for (const subtype of decisions) {
      expect(canResolveSubtype(cashier, subtype)).toBe(false);
    }
  });

  it('denies receipts to a Manager without update:ReceiptEvidence only', () => {
    expect(canResolveSubtype(manager, 'RESTOCK')).toBe(true);
    expect(canResolveSubtype(manager, 'EXPIRATION')).toBe(true);
    expect(canResolveSubtype(manager, 'DELIVERY_ZONE')).toBe(true);
    expect(canResolveSubtype(manager, 'TRANSFER_RECEIPT')).toBe(false);
  });

  it('allows every subtype with all the permissions, and with manage:all', () => {
    for (const subtype of decisions) {
      expect(canResolveSubtype(managerWithReceipts, subtype)).toBe(true);
      expect(canResolveSubtype(superAdmin, subtype)).toBe(true);
    }
  });
});
