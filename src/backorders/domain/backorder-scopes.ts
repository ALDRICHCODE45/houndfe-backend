/**
 * Scopes of the chatbot's `svc_` credential for the backorder routes (contract
 * v1 §6). `ServiceCredential.scopes` is free text and `ServiceAuthGuard` only
 * compares strings, so this list is the one place the routes name them;
 * `docs/chatbot-handoff/restock-backorder-bot-contract.md` repeats it for the
 * deploy checklist.
 */
export const BACKORDER_SCOPES = {
  create: 'backorders:create',
  read: 'backorders:read',
  cancel: 'backorders:cancel',
} as const;
