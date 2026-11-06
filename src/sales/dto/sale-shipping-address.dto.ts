import type { ShippingAddressSourceStatus } from '../domain/shipping-address-source-status';

/**
 * Sale-time shipping address snapshot, as exposed by `GET /sales` and
 * `GET /sales/:id`. Values never follow later edits to the customer address;
 * `sourceStatus` / `changedFields` report how the live source differs.
 */
export interface SaleShippingAddressDto {
  /** Source customer-address id; null once that address was deleted. */
  id: string | null;
  street: string;
  exteriorNumber: string | null;
  interiorNumber: string | null;
  zipCode: string | null;
  neighborhood: string | null;
  municipality: string | null;
  city: string | null;
  state: string | null;
  visualReferences: string | null;
  carrierPhone: string | null;
  label: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Live source vs this snapshot; DELETED when the source is gone. */
  sourceStatus: ShippingAddressSourceStatus;
  /** Snapshot keys that differ from the source; `[]` unless CHANGED. */
  changedFields: string[];
}
