import { toNotificationView } from './notification-view';

const CREATED = new Date('2026-11-12T10:00:00.000Z');

const row = (over: Record<string, unknown> = {}) => ({
  id: 'n-1',
  type: 'REQUEST_CREATED',
  payload: { folio: 123, subtype: 'UNKNOWN_QUESTION' } as unknown,
  requestId: 'r-1' as string | null,
  createdAt: CREATED,
  readAt: null as Date | null,
  requestStatus: 'NEW' as string | null,
  ...over,
});

describe('toNotificationView (S10)', () => {
  it('keeps the existing keys and adds folio, subtype, cause, reason and requestOpen', () => {
    expect(toNotificationView(row())).toEqual({
      id: 'n-1',
      type: 'REQUEST_CREATED',
      title: 'Nueva solicitud',
      body: 'Pregunta sin respuesta · S-000123',
      requestId: 'r-1',
      createdAt: '2026-11-12T10:00:00.000Z',
      readAt: null,
      folio: 'S-000123',
      subtype: 'UNKNOWN_QUESTION',
      cause: null,
      reason: null,
      requestOpen: true,
    });
  });

  it('formats the folio like the inbox and pads it to six digits', () => {
    expect(
      toNotificationView(row({ payload: { folio: 7, subtype: 'RESTOCK' } })),
    ).toMatchObject({ folio: 'S-000007', subtype: 'RESTOCK' });
    expect(
      toNotificationView(
        row({ payload: { folio: 1234567, subtype: 'RESTOCK' } }),
      ).folio,
    ).toBe('S-1234567');
  });

  describe('older rows are null-safe', () => {
    it.each([
      ['an empty payload', {}],
      ['a null payload', null],
      ['a payload that is not an object', 'x'],
      ['a payload with wrong types', { folio: '12', subtype: 7, cause: 3 }],
    ])('%s gives nulls, never throws', (_label, payload) => {
      expect(toNotificationView(row({ payload }))).toMatchObject({
        folio: null,
        subtype: null,
        cause: null,
        reason: null,
      });
    });

    it('a payload from before causes existed reads with cause null and the customer wording', () => {
      expect(
        toNotificationView(
          row({
            type: 'REQUEST_CANCELLED',
            payload: { folio: 9, subtype: 'COMPLAINT' },
          }),
        ),
      ).toMatchObject({
        title: 'El cliente canceló la solicitud',
        cause: null,
        folio: 'S-000009',
      });
    });
  });

  describe('cause', () => {
    it.each([
      'CUSTOMER',
      'RESOLVED_BY_OTHER',
      'CANCELLED_BY_OTHER',
      'SIBLING_RESOLVED',
      'MERGED',
    ])('exposes the stored cause %s', (cause) => {
      expect(
        toNotificationView(
          row({
            type: 'REQUEST_CANCELLED',
            payload: { folio: 4, subtype: 'UNKNOWN_QUESTION', cause },
          }),
        ).cause,
      ).toBe(cause);
    });

    it('an unknown stored cause reads as null and does not break the text', () => {
      const view = toNotificationView(
        row({
          type: 'REQUEST_CANCELLED',
          payload: { folio: 4, subtype: 'UNKNOWN_QUESTION', cause: 'ALIEN' },
        }),
      );
      expect(view.cause).toBeNull();
      expect(view.title).toBe('El cliente canceló la solicitud');
    });
  });

  describe('reason', () => {
    const payload = (reason?: unknown) => ({
      folio: 5,
      subtype: 'UNKNOWN_QUESTION',
      ...(reason === undefined ? {} : { reason }),
    });

    it.each(['REQUEST_ESCALATION', 'REQUEST_OVERDUE'])(
      '%s exposes ASSIGNEE and ESCALATION',
      (type) => {
        expect(
          toNotificationView(row({ type, payload: payload('ASSIGNEE') }))
            .reason,
        ).toBe('ASSIGNEE');
        expect(
          toNotificationView(row({ type, payload: payload('ESCALATION') }))
            .reason,
        ).toBe('ESCALATION');
      },
    );

    it('is null on an escalation row written before reasons existed, or with an unknown value', () => {
      expect(
        toNotificationView(row({ type: 'REQUEST_OVERDUE', payload: payload() }))
          .reason,
      ).toBeNull();
      expect(
        toNotificationView(
          row({ type: 'REQUEST_OVERDUE', payload: payload('BOSS') }),
        ).reason,
      ).toBeNull();
    });

    it.each([
      'REQUEST_CREATED',
      'REQUEST_REASSIGNED',
      'REQUEST_CANCELLED',
      'REQUEST_CLAIM_REMINDER',
    ])('is always null for %s, whatever the payload says', (type) => {
      expect(
        toNotificationView(row({ type, payload: payload('ASSIGNEE') })).reason,
      ).toBeNull();
    });
  });

  describe('requestOpen', () => {
    it.each([
      ['NEW', true],
      ['IN_PROGRESS', true],
      ['RESOLVED', false],
      ['CANCELLED', false],
    ])('%s → %s', (requestStatus, open) => {
      expect(toNotificationView(row({ requestStatus })).requestOpen).toBe(open);
    });

    it('is null without a request id, and when the request is gone', () => {
      expect(
        toNotificationView(row({ requestId: null, requestStatus: null }))
          .requestOpen,
      ).toBeNull();
      expect(
        toNotificationView(row({ requestStatus: null })).requestOpen,
      ).toBeNull();
    });
  });

  it('serialises readAt when read', () => {
    expect(
      toNotificationView(row({ readAt: new Date('2026-11-12T11:00:00.000Z') }))
        .readAt,
    ).toBe('2026-11-12T11:00:00.000Z');
  });
});
