/**
 * Test-only offline MAILER implementation shared by the disposable
 * harnesses (cash-live, editorial-live). Fail closed: every send throws
 * with a FIXED message (input is never echoed). Light module: it imports
 * only the MAILER port TYPE, so importing it never loads Nest or Prisma.
 */
import type { IMailer } from '../../src/notifications/email/mailer.port';

export class OfflineNoSendMailer implements IMailer {
  send(): Promise<void> {
    return Promise.reject(
      new Error(
        'cash-live harness: outbound email is disabled (offline MAILER override)',
      ),
    );
  }
}
