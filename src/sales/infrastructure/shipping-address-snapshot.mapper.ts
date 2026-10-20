import type { Sale as PrismaSale } from '@prisma/client';
import type { ShippingAddressSnapshot } from '../domain/shipping-address-snapshot';

export function shippingAddressColumns(
  snapshot: ShippingAddressSnapshot | null,
) {
  return {
    shippingStreet: snapshot?.street ?? null,
    shippingExteriorNumber: snapshot?.exteriorNumber ?? null,
    shippingInteriorNumber: snapshot?.interiorNumber ?? null,
    shippingZipCode: snapshot?.zipCode ?? null,
    shippingNeighborhood: snapshot?.neighborhood ?? null,
    shippingMunicipality: snapshot?.municipality ?? null,
    shippingCity: snapshot?.city ?? null,
    shippingState: snapshot?.state ?? null,
    shippingVisualReferences: snapshot?.visualReferences ?? null,
    shippingCarrierPhone: snapshot?.carrierPhone ?? null,
    shippingLabel: snapshot?.label ?? null,
    shippingLatitude: snapshot?.latitude ?? null,
    shippingLongitude: snapshot?.longitude ?? null,
  };
}

export const shippingAddressSnapshotSelect = {
  shippingStreet: true,
  shippingExteriorNumber: true,
  shippingInteriorNumber: true,
  shippingZipCode: true,
  shippingNeighborhood: true,
  shippingMunicipality: true,
  shippingCity: true,
  shippingState: true,
  shippingVisualReferences: true,
  shippingCarrierPhone: true,
  shippingLabel: true,
  shippingLatitude: true,
  shippingLongitude: true,
} as const;

export type SnapshotRow = Pick<
  PrismaSale,
  keyof ReturnType<typeof shippingAddressColumns>
>;

export function hydrateShippingAddress(
  row: SnapshotRow,
): ShippingAddressSnapshot | null {
  if (row.shippingStreet == null) return null;
  return {
    street: row.shippingStreet,
    exteriorNumber: row.shippingExteriorNumber,
    interiorNumber: row.shippingInteriorNumber,
    zipCode: row.shippingZipCode,
    neighborhood: row.shippingNeighborhood,
    municipality: row.shippingMunicipality,
    city: row.shippingCity,
    state: row.shippingState,
    visualReferences: row.shippingVisualReferences,
    carrierPhone: row.shippingCarrierPhone,
    label: row.shippingLabel,
    latitude: row.shippingLatitude,
    longitude: row.shippingLongitude,
  };
}
