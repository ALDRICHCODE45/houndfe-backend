import type { PetView } from '../../../customer-pets/domain/customer-pet.types';

export interface CustomerDeliveryAddressResponse {
  id: string;
  label: string | null;
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
}

export interface CustomerProfileResponse {
  customerId: string;
  firstName: string;
  lastName: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  preferredPaymentMethod: string | null;
  address: CustomerDeliveryAddressResponse | null;
}

/**
 * `GET customers/by-phone` profile. `pets` (ACTIVE pets, the full pet view of
 * contract §2) is present ONLY when the credential also has `pets:read`
 * (contract §7); otherwise the key is absent, not empty.
 */
export interface CustomerLookupProfile extends CustomerProfileResponse {
  pets?: PetView[];
}

export interface CustomerLookupResponse {
  found: boolean;
  customer: CustomerLookupProfile | null;
}

export interface CustomerUpsertResponse {
  status: 'created' | 'updated';
  customer: CustomerProfileResponse;
}
