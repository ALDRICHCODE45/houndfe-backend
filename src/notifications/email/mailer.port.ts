/**
 * PORT: IMailer — Driven Port for outbound email.
 *
 * Slice F.1 of `low-stock-alerts`. The only public surface for the
 * stock-alerts / Inngest / outbox dispatch flow is `MAILER.send(...)`.
 * No other code path calls Resend directly.
 *
 * Contract:
 *
 *   - `to: string[]` is a list of recipient email addresses; the
 *     adapter may batch them (Resend accepts an array) or send one
 *     message with multiple `To:` recipients. There is exactly ONE
 *     outbound HTTP call per `send` invocation, regardless of how
 *     many recipients there are.
 *
 *   - `html` is the rendered React Email output (`render(<Email .../>)`).
 *     Adapters MUST NOT mutate it; they MUST forward it verbatim.
 *
 *   - Implementations THROW on rejection (Resend 4xx/5xx, network).
 *     The dedicated outbox dispatcher (Slice F.5) interprets a throw
 *     as "send failed ⇒ keep PENDING + retry"; a silent no-op would
 *     lose the alert.
 *
 *   - In NODE_ENV !== production with no `RESEND_API_KEY`, the dev
 *     fallback path is used (`ResendMailer` ⇒ logger). Recipients are
 *     redacted from the log so PII never leaks in shared test
 *     output (design finding #4).
 *
 * Spec coverage:
 *   - design.md "Inngest + Resend Wiring" (MAILER paragraph).
 */
export interface SendMailInput {
  to: string[];
  subject: string;
  html: string;
}

export interface IMailer {
  /**
   * Send one rendered email to the supplied recipients. Resolves on
   * 2xx response from the upstream provider; rejects with the
   * upstream error on any failure or on validation rejections.
   */
  send(input: SendMailInput): Promise<void>;
}

/**
 * NestJS injection token for the mailer port. `Symbol.for(...)` so
 * the token dedupes across module instances (mirrors the
 * notification-config and stock-alerts ports).
 */
export const MAILER = Symbol.for('Mailer');
