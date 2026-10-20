/** Delivery facts owned by a sale, not a reference to a customer's mutable address. */
export interface ShippingAddressSnapshot {
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
}

/** Copy only delivery fields; exclude customer identity and persistence metadata. */
export function copyShippingAddress(
  address: ShippingAddressSnapshot,
): ShippingAddressSnapshot {
  return {
    street: address.street,
    exteriorNumber: address.exteriorNumber ?? null,
    interiorNumber: address.interiorNumber ?? null,
    zipCode: address.zipCode ?? null,
    neighborhood: address.neighborhood ?? null,
    municipality: address.municipality ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    visualReferences: address.visualReferences ?? null,
    carrierPhone: address.carrierPhone ?? null,
    label: address.label ?? null,
    latitude: address.latitude ?? null,
    longitude: address.longitude ?? null,
  };
}
