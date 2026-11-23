/**
 * Scopes of the chatbot's `svc_` credential for the pet routes (contract v1
 * §7). `ServiceCredential.scopes` is free text and `ServiceAuthGuard` only
 * compares strings, so this list is the one place the routes name them; the
 * handoff doc and the production credential checklist repeat it. `pets:read`
 * also gates the additive `customer.pets` of `GET customers/by-phone`.
 */
export const CUSTOMER_PET_SCOPES = {
  read: 'pets:read',
  write: 'pets:write',
  delete: 'pets:delete',
} as const;
