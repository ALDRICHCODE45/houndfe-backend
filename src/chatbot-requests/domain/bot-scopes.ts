/**
 * Scopes of the chatbot's `svc_` credential for the human-intervention
 * contract (§3.1, §11.2 item 3). `ServiceCredential.scopes` is free text
 * (§1.4) and `ServiceAuthGuard` only compares strings, so this list is the one
 * place the new routes name them; `docs/chatbot-handoff/` repeats it for the
 * deploy checklist.
 */
export const BOT_SCOPES = {
  requestsCreate: 'requests:create',
  requestsRead: 'requests:read',
  requestsCancel: 'requests:cancel',
  feedRead: 'feed:read',
  feedAck: 'feed:ack',
  conversationWrite: 'conversation:write',
  mediaWrite: 'media:write',
} as const;

export const BOT_SCOPE_LIST: readonly string[] = Object.values(BOT_SCOPES);
