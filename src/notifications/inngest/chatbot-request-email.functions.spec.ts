import type { Inngest } from 'inngest';
import type { SendMailInput } from '../email/mailer.port';
import type { NoticeEmailEvent } from '../outbox/chatbot-request-email.dispatcher';
import {
  buildChatbotRequestEmailFunctions,
  type INoticeEmailLoader,
  type NoticeEmailLoad,
} from './chatbot-request-email.functions';

type Handler = (ctx: {
  event: { id: string; name: string; data: NoticeEmailEvent };
  step: { run: (name: string, fn: () => Promise<unknown>) => Promise<unknown> };
}) => Promise<unknown>;

const EVENT: NoticeEmailEvent = {
  tenantId: 'tenant-1',
  userId: 'user-1',
  mode: 'BATCH',
  notificationIds: ['n1', 'n2'],
};

const requestIdOf = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const item = (n: number, subtype = 'RESTOCK') => ({
  type: 'REQUEST_CREATED' as const,
  requestId: requestIdOf(n),
  folio: n,
  subtype,
});

function setup(load: NoticeEmailLoad | null) {
  const captured: Array<{
    options: Record<string, unknown>;
    handler: Handler;
  }> = [];
  const inngestClient = {
    createFunction: (options: Record<string, unknown>, handler: Handler) => {
      captured.push({ options, handler });
      return { options };
    },
  } as unknown as Inngest;
  const load_ = jest.fn().mockResolvedValue(load);
  const loader: INoticeEmailLoader = { load: load_ };
  const send = jest.fn<Promise<void>, [SendMailInput]>().mockResolvedValue();
  buildChatbotRequestEmailFunctions({
    inngestClient,
    loader,
    mailer: { send },
    appBaseUrl: 'https://app.example.com',
  });
  const steps: string[] = [];
  const run = (data: NoticeEmailEvent = EVENT) =>
    captured[0].handler({
      event: { id: 'evt-1', name: 'chatbot-request/email.requested', data },
      step: {
        run: (name, fn) => {
          steps.push(name);
          return fn();
        },
      },
    });
  return { captured, run, send, load: load_, steps };
}

describe('chatbot-request notice email (Inngest function)', () => {
  it('registers on chatbot-request/email.requested with event-id idempotency', () => {
    const { captured } = setup(null);
    expect(captured[0].options).toMatchObject({
      id: 'chatbot-request-notice-email',
      triggers: [{ event: 'chatbot-request/email.requested' }],
      idempotency: 'event.id',
    });
  });

  it('sends one email with the exact subject and a deep link per request', async () => {
    const { run, send, steps } = setup({
      email: 'ana@example.com',
      branchName: 'Sucursal Centro',
      items: [item(123, 'TALK_TO_HUMAN')],
    });

    await expect(run()).resolves.toEqual({ sent: true, notices: 1 });

    expect(steps).toEqual(['load', 'send-email']);
    const mail = send.mock.calls[0][0];
    expect(mail.to).toEqual(['ana@example.com']);
    expect(mail.subject).toBe(
      '[HoundFe] Nueva solicitud: Conversación en vivo (Sucursal Centro) · S-000123',
    );
    expect(mail.html).toContain(
      `https://app.example.com/chatbot/solicitudes/${requestIdOf(123)}`,
    );
  });

  it('groups a batch into one email with a link for each request', async () => {
    const { run, send } = setup({
      email: 'ana@example.com',
      branchName: 'Sucursal Centro',
      items: [item(1), item(2), item(3, 'UNKNOWN_QUESTION')],
    });

    await run();

    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail.subject).toBe(
      '[HoundFe] 3 solicitudes nuevas (Sucursal Centro)',
    );
    for (const n of [1, 2, 3]) {
      expect(mail.html).toContain(`S-00000${n}`);
      expect(mail.html).toContain(`/chatbot/solicitudes/${requestIdOf(n)}`);
    }
  });

  it('never carries a customer name or phone (§6.3, D5)', async () => {
    const { run, send } = setup({
      email: 'ana@example.com',
      branchName: 'Sucursal Centro',
      items: [item(5, 'COMPLAINT')],
    });
    // Even if something upstream leaked them into the event or the loaded
    // items, the template only renders type, branch, folio and the link.
    const polluted = {
      ...EVENT,
      customerName: 'María Pérez',
      phone: '5512345678',
    } as NoticeEmailEvent;

    await run(polluted);

    const mail = send.mock.calls[0][0];
    for (const forbidden of ['María', 'Pérez', '5512345678', '55 ****']) {
      expect(mail.html).not.toContain(forbidden);
      expect(mail.subject).not.toContain(forbidden);
    }
  });

  it.each([
    ['nobody to email (inactive, off or not a member)', null],
    ['no notices left', { email: 'a@b.c', branchName: 'S', items: [] }],
  ])('skips when there is %s', async (_label, load) => {
    const { run, send } = setup(load as NoticeEmailLoad | null);
    await expect(run()).resolves.toEqual({ skipped: 'nobody-to-email' });
    expect(send).not.toHaveBeenCalled();
  });

  it('skips a malformed event without loading anything', async () => {
    const { run, load, send } = setup(null);
    await expect(run({ ...EVENT, notificationIds: [] })).resolves.toEqual({
      skipped: 'malformed-event',
    });
    expect(load).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
