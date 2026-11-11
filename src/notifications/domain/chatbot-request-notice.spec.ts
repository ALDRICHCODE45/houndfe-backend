import {
  EMAIL_BATCH_WINDOW_MS,
  NOTICE_OUTBOX_EVENT_TYPES,
  NOTICE_TYPES,
  audienceOf,
  batchWindowEnd,
  emailModeOf,
  formatFolio,
  noticeText,
  requestDeepLink,
  slaNoticeDropReason,
} from './chatbot-request-notice';

describe('notice audiences (contract §5.1 table)', () => {
  it.each([
    ['REQUEST_CREATED', 'HANDLERS'],
    ['REQUEST_CLAIM_REMINDER', 'HANDLERS'],
    ['REQUEST_ESCALATION', 'ESCALATION_VIEWERS'],
    ['REQUEST_OVERDUE', 'ESCALATION_VIEWERS'],
    ['REQUEST_REASSIGNED', 'USER'],
    ['REQUEST_CANCELLED', 'USER'],
  ] as const)('%s goes to %s', (type, audience) => {
    expect(audienceOf(type)).toBe(audience);
  });

  it('knows an audience for every type', () => {
    for (const type of NOTICE_TYPES) expect(audienceOf(type)).toBeDefined();
  });
});

describe('email mode (D5)', () => {
  it('batches a new request of an ordinary subtype', () => {
    for (const subtype of ['RESTOCK', 'UNKNOWN_QUESTION', 'TRANSFER_RECEIPT']) {
      expect(emailModeOf('REQUEST_CREATED', subtype)).toBe('BATCH');
    }
  });

  it('sends live conversations and complaints alone and immediately', () => {
    expect(emailModeOf('REQUEST_CREATED', 'TALK_TO_HUMAN')).toBe('IMMEDIATE');
    expect(emailModeOf('REQUEST_CREATED', 'COMPLAINT')).toBe('IMMEDIATE');
  });

  it('sends the other emailed types one per event and never mails a cancel', () => {
    expect(emailModeOf('REQUEST_REASSIGNED', 'RESTOCK')).toBe('IMMEDIATE');
    expect(emailModeOf('REQUEST_ESCALATION', 'RESTOCK')).toBe('IMMEDIATE');
    expect(emailModeOf('REQUEST_CANCELLED', 'RESTOCK')).toBe('NONE');
  });
});

describe('batch window', () => {
  it('ends at the next 2-minute clock boundary', () => {
    const now = new Date('2026-11-11T10:03:41.500Z');
    expect(batchWindowEnd(now).toISOString()).toBe('2026-11-11T10:04:00.000Z');
  });

  it('groups every instant of one window under the same end', () => {
    const ends = [0, 1, 59_999, 119_999].map((offset) =>
      batchWindowEnd(new Date(Date.UTC(2026, 10, 11, 10, 4, 0) + offset)),
    );
    expect(new Set(ends.map((end) => end.getTime())).size).toBe(1);
  });

  it('moves to the next window exactly on the boundary', () => {
    const boundary = new Date('2026-11-11T10:04:00.000Z');
    expect(batchWindowEnd(boundary).getTime() - boundary.getTime()).toBe(
      EMAIL_BATCH_WINDOW_MS,
    );
  });
});

describe('text and links', () => {
  it('formats the folio and builds the in-app text without customer data', () => {
    expect(formatFolio(123)).toBe('S-000123');
    expect(
      noticeText('REQUEST_CREATED', { folio: 7, subtype: 'COMPLAINT' }),
    ).toEqual({ title: 'Nueva solicitud', body: 'Queja · S-000007' });
  });

  it.each([
    ['CUSTOMER', 'El cliente canceló la solicitud'],
    ['RESOLVED_BY_OTHER', 'Otra persona resolvió la solicitud'],
    ['CANCELLED_BY_OTHER', 'Otra persona canceló la solicitud'],
    ['SIBLING_RESOLVED', 'Se resolvió junto con otras de su zona'],
    ['MERGED', 'Otra persona la unió con otra solicitud del cliente'],
  ] as const)('words a closed notice by its cause (%s)', (cause, title) => {
    expect(
      noticeText('REQUEST_CANCELLED', {
        folio: 7,
        subtype: 'DELIVERY_ZONE',
        cause,
      }),
    ).toEqual({ title, body: 'Zona de entrega · S-000007' });
  });

  it('keeps the customer wording for a closed notice written before causes existed', () => {
    expect(
      noticeText('REQUEST_CANCELLED', { folio: 7, subtype: 'RESTOCK' }).title,
    ).toBe('El cliente canceló la solicitud');
  });

  it('falls back for an unknown type or an empty payload', () => {
    expect(noticeText('SOMETHING_NEW', null)).toEqual({
      title: 'Aviso',
      body: '',
    });
  });

  it('builds the deep link from the web url without doubling slashes', () => {
    expect(requestDeepLink('https://app.example.com/', 'abc')).toBe(
      'https://app.example.com/chatbot/solicitudes/abc',
    );
  });
});

describe('R3 — outbox event types', () => {
  it('lives under the prefix the generic poller excludes', () => {
    for (const type of NOTICE_OUTBOX_EVENT_TYPES) {
      expect(type.startsWith('chatbot_request.')).toBe(true);
    }
  });
});

describe('slaNoticeDropReason: a held SLA notice that no longer applies is dropped', () => {
  const START = new Date('2026-11-10T16:00:00.000Z');
  const open = (over = {}) => ({
    status: 'NEW' as const,
    claimStart: START,
    ...over,
  });
  const notice = (type: string, claimCycle?: number) => ({
    type,
    ...(claimCycle === undefined ? {} : { claimCycle }),
  });

  it.each(['REQUEST_CLAIM_REMINDER', 'REQUEST_ESCALATION', 'REQUEST_OVERDUE'])(
    '%s is dropped when the request is closed at consume time',
    (type) => {
      for (const status of ['RESOLVED', 'CANCELLED'] as const) {
        expect(
          slaNoticeDropReason(notice(type, START.getTime()), open({ status })),
        ).toBe('REQUEST_CLOSED');
      }
    },
  );

  it('REQUEST_ESCALATION and REQUEST_OVERDUE still apply to a request that is claimed (only closing drops them)', () => {
    for (const type of ['REQUEST_ESCALATION', 'REQUEST_OVERDUE']) {
      expect(
        slaNoticeDropReason(notice(type), open({ status: 'IN_PROGRESS' })),
      ).toBeNull();
    }
  });

  it('REQUEST_CLAIM_REMINDER is dropped when the request was claimed since', () => {
    expect(
      slaNoticeDropReason(
        notice('REQUEST_CLAIM_REMINDER', START.getTime()),
        open({ status: 'IN_PROGRESS' }),
      ),
    ).toBe('CLAIMED_SINCE');
  });

  it('REQUEST_CLAIM_REMINDER is dropped when the claim cycle changed (released and restarted)', () => {
    expect(
      slaNoticeDropReason(
        notice('REQUEST_CLAIM_REMINDER', START.getTime()),
        open({ claimStart: new Date(START.getTime() + 60_000) }),
      ),
    ).toBe('CLAIM_CYCLE_CHANGED');
  });

  it('REQUEST_CLAIM_REMINDER of a still-NEW request in the same cycle is delivered', () => {
    expect(
      slaNoticeDropReason(
        notice('REQUEST_CLAIM_REMINDER', START.getTime()),
        open(),
      ),
    ).toBeNull();
  });

  it('a notice without a cycle (written before it existed) is judged on status only', () => {
    expect(
      slaNoticeDropReason(notice('REQUEST_CLAIM_REMINDER'), open()),
    ).toBeNull();
  });

  it('a missing request drops an SLA notice (nothing to link to)', () => {
    expect(slaNoticeDropReason(notice('REQUEST_OVERDUE'), null)).toBe(
      'REQUEST_MISSING',
    );
  });

  it.each(['REQUEST_CREATED', 'REQUEST_REASSIGNED', 'REQUEST_CANCELLED'])(
    '%s is never judged: unchanged behavior',
    (type) => {
      expect(
        slaNoticeDropReason(notice(type), open({ status: 'RESOLVED' })),
      ).toBeNull();
      expect(slaNoticeDropReason(notice(type), null)).toBeNull();
    },
  );
});
