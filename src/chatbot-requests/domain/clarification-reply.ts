/**
 * DOMAIN: the text of a staff clarification reply (human-intervention unit 10;
 * contract §3.8 `reply {text ≤ 1500}`, §6.1, §6.4). Pure.
 *
 * Staff typed it, but it ends up on a customer's WhatsApp and in a browser, so
 * it is treated as untrusted text: control characters and bidi
 * embedding/override/isolate marks are dropped, the ends are trimmed, and it
 * is stored as typed and rendered as text, never interpreted as HTML (markup
 * is kept verbatim as characters). The length is counted in characters, like
 * WhatsApp and the mirror do. The error never echoes the text.
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { sanitizeMessageText } from '../../conversations/domain/conversation-message';

export const REPLY_LIMITS = {
  /** §6.4: "Respuesta de aclaración: 1500 caracteres". */
  textMax: 1500,
} as const;

/** The text to store and relay; throws `VALIDATION_ERROR` when it is not usable. */
export function parseReplyText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InvalidArgumentError('Invalid reply', 'VALIDATION_ERROR');
  }
  const text = sanitizeMessageText(value).trim();
  if (text.length === 0 || Array.from(text).length > REPLY_LIMITS.textMax) {
    throw new InvalidArgumentError('Invalid reply', 'VALIDATION_ERROR');
  }
  return text;
}
