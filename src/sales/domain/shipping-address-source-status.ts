import type { ShippingAddressSnapshot } from './shipping-address-snapshot';

/** How a sale's shipping snapshot relates to the customer address it was copied from. */
export type ShippingAddressSourceStatus = 'UNCHANGED' | 'CHANGED' | 'DELETED';

export type ShippingAddressSnapshotKey = keyof ShippingAddressSnapshot;

export interface ShippingAddressSourceComparison {
  sourceStatus: ShippingAddressSourceStatus;
  /** Snapshot keys that differ from the live source, in snapshot key order. */
  changedFields: ShippingAddressSnapshotKey[];
}

/** Fixed comparison and `changedFields` order. */
export const SHIPPING_ADDRESS_SNAPSHOT_KEYS: readonly ShippingAddressSnapshotKey[] =
  [
    'street',
    'exteriorNumber',
    'interiorNumber',
    'zipCode',
    'neighborhood',
    'municipality',
    'city',
    'state',
    'visualReferences',
    'carrierPhone',
    'label',
    'latitude',
    'longitude',
  ];

export type LiveShippingAddressSource = {
  [K in ShippingAddressSnapshotKey]?: ShippingAddressSnapshot[K] | undefined;
};

/**
 * Compare a sale snapshot with its live source address. A missing source is
 * DELETED. Values are compared strictly (coordinates included, no tolerance)
 * with undefined treated as null; persistence metadata is ignored.
 */
export function compareShippingAddressSource(
  snapshot: ShippingAddressSnapshot,
  live: LiveShippingAddressSource | null | undefined,
): ShippingAddressSourceComparison {
  if (live == null) return { sourceStatus: 'DELETED', changedFields: [] };
  const changedFields = SHIPPING_ADDRESS_SNAPSHOT_KEYS.filter(
    (key) => (snapshot[key] ?? null) !== (live[key] ?? null),
  );
  return {
    sourceStatus: changedFields.length === 0 ? 'UNCHANGED' : 'CHANGED',
    changedFields,
  };
}
