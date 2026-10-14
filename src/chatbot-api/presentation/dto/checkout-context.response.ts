export interface CheckoutContextCustomer {
  customerId: string;
  firstName: string;
  lastName: string | null;
}

export interface CheckoutContextAddress {
  id: string;
  /** ISO updatedAt freshness marker, not a compare-and-swap edit token. */
  version: string;
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

export type CheckoutContextResponse =
  | {
      status: 'not_found' | 'ambiguous';
      customer: null;
      addresses: [];
      nextAfterAddressId: null;
    }
  | {
      status: 'unique';
      customer: CheckoutContextCustomer;
      addresses: CheckoutContextAddress[];
      nextAfterAddressId: string | null;
    };
