/**
 * Slice F.1 — MAILER port (driven port).
 *
 * Strategy: written FIRST (RED) so we pin the contract before the
 * `ResendMailer` adapter (Slice F.1 adapter) and the Inngest
 * function (Slice F.2) consume it.
 *
 * Contract:
 *   - `MAILER` is the NestJS injection token. Adapters are
 *     supplied by `ResendMailer` (prod) or the redacted dev-logger
 *     fallback.
 *   - `IMailer.send({ to[], subject, html })` is the ONLY public API.
 *     `to` accepts multiple recipients (one API call per email blast;
 *     the dev-logger fallback redacts the addresses when
 *     `RESEND_API_KEY` is unset).
 *   - Implementations MUST throw on rejection (Resend non-2xx,
 *     network) so the dedicated outbox dispatcher (Slice F.5) can
 *     interpret reject → PENDING + retry.
 *
 * Spec coverage (notification-config/spec.md + design.md "Inngest +
 * Resend Wiring"):
 *   - "Disabled config → no send" → no mailer call. This spec
 *     verifies the PORT itself is non-throwing on the happy path; the
 *     short-circuit happens at the Inngest function boundary (F.2).
 *   - "DEV redacts recipients" → enforced at the
 *     `ResendMailer` adapter (F.1) — the port just defines the shape.
 */
import {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  MAILER,
  type IMailer,
  type SendMailInput,
} from './mailer.port';

describe('MAILER port (F.1)', () => {
  it('exports the injection token as a Symbol with a stable description', () => {
    expect(typeof MAILER).toBe('symbol');
    expect(MAILER.description).toBe('Mailer');
  });

  it('IMailer.send is a method whose input shape matches SendMailInput', () => {
    // Type-level smoke: a value typed as IMailer MUST accept the
    // documented input shape. If this compiles, the contract holds.
    const mailer: IMailer = {
      send: async (_input: SendMailInput) => undefined,
    };
    expect(typeof mailer.send).toBe('function');
  });

  it('SendMailInput accepts an array of recipients (one-blast-per-call semantics)', () => {
    // Compile-time shape: just assert the literal type below satisfies
    // SendMailInput. The TS compiler is the source of truth here;
    // this is a belt-and-braces runtime guard so the literal stays
    // stable under future refactors.
    const input: SendMailInput = {
      to: ['a@example.com', 'b@example.com'],
      subject: 's',
      html: '<p>hi</p>',
    };
    expect(input.to).toHaveLength(2);
    expect(input.html).toContain('<p>');
  });
});
