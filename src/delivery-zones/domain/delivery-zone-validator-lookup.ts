/**
 * shipping-zones / T1 (S3) — PORT: which configured notification recipients
 * can actually validate delivery zones in the current tenant.
 *
 * A recipient qualifies when one of their tenant roles grants
 * `validate:DeliveryZone`, `manage:DeliveryZone` or `manage:all` (CASL
 * `manage` is a wildcard). Inactive users never qualify.
 */
export interface IDeliveryZoneValidatorLookup {
  filterValidators(userIds: string[]): Promise<string[]>;
}

export const DELIVERY_ZONE_VALIDATOR_LOOKUP = Symbol(
  'DELIVERY_ZONE_VALIDATOR_LOOKUP',
);
