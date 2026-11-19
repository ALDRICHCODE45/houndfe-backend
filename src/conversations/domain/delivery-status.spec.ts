import {
  DELIVERY_STATUSES,
  canAdvanceDeliveryStatus,
  initialDeliveryStatus,
} from './delivery-status';

describe('delivery status transitions (§6.2)', () => {
  const allowed: Array<[string, string]> = [
    ['QUEUED', 'DEFERRED'],
    ['QUEUED', 'SENT'],
    ['QUEUED', 'DELIVERED'],
    ['QUEUED', 'READ'],
    ['QUEUED', 'FAILED'],
    ['QUEUED', 'UNKNOWN'],
    ['DEFERRED', 'SENT'],
    ['DEFERRED', 'DELIVERED'],
    ['DEFERRED', 'READ'],
    ['DEFERRED', 'FAILED'],
    ['DEFERRED', 'UNKNOWN'],
    ['SENT', 'DELIVERED'],
    ['SENT', 'READ'],
    ['SENT', 'FAILED'],
    ['SENT', 'UNKNOWN'],
    ['DELIVERED', 'READ'],
  ];

  it.each(allowed)('%s -> %s advances', (from, to) => {
    expect(canAdvanceDeliveryStatus(from, to)).toBe(true);
  });

  it('refuses everything else: no step back, no repeat, nothing leaves a terminal state, a delivered message cannot fail', () => {
    const allowedKeys = new Set(allowed.map(([a, b]) => `${a}>${b}`));
    for (const from of DELIVERY_STATUSES) {
      for (const to of DELIVERY_STATUSES) {
        expect(canAdvanceDeliveryStatus(from, to)).toBe(
          allowedKeys.has(`${from}>${to}`),
        );
      }
    }
  });

  it('a message with no status never gets one afterwards', () => {
    for (const to of DELIVERY_STATUSES) {
      expect(canAdvanceDeliveryStatus(null, to)).toBe(false);
    }
  });

  it('a bot message is already SENT when it is mirrored; customer messages have none', () => {
    expect(initialDeliveryStatus('OUT', 'BOT')).toBe('SENT');
    expect(initialDeliveryStatus('IN', 'CUSTOMER')).toBeNull();
    expect(initialDeliveryStatus('OUT', 'SYSTEM')).toBeNull();
    expect(initialDeliveryStatus('OUT', 'STAFF')).toBe('QUEUED');
  });
});
