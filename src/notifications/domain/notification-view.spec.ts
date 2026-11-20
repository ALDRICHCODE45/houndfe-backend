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
      saleId: null,
      backorderId: null,
      createdAt: '2026-11-12T10:00:00.000Z',
      readAt: null,
      folio: 'S-000123',
      subtype: 'UNKNOWN_QUESTION',
      cause: null,
      reason: null,
      requestOpen: true,
      level: null,
    });
  });

  describe('level', () => {
    it.each([5, 15])(
      'a CONVERSATION_UNANSWERED row exposes level %i as a flat field',
      (level) => {
        const view = toNotificationView(
          row({
            type: 'CONVERSATION_UNANSWERED',
            payload: { folio: 7, subtype: 'TALK_TO_HUMAN', level },
          }),
        );
        expect(view.level).toBe(level);
        expect(view.title).toBe(`Cliente esperando respuesta (${level} min)`);
      },
    );

    it('is null for other types, and for an unknown stored value', () => {
      expect(
        toNotificationView(
          row({ type: 'REQUEST_CREATED', payload: { folio: 1, level: 5 } }),
        ).level,
      ).toBeNull();
      expect(
        toNotificationView(
          row({ type: 'CONVERSATION_UNANSWERED', payload: { level: 7 } }),
        ).level,
      ).toBeNull();
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

  describe('sale notice (pay-in-store-pickup / T2)', () => {
    it('a SALE_HOLD_REVIEW row names the sale, its folio and the reason; no request fields', () => {
      expect(
        toNotificationView(
          row({
            type: 'SALE_HOLD_REVIEW',
            requestId: null,
            requestStatus: null,
            payload: {
              saleId: 's-1',
              saleFolio: 'V-000042',
              reason: 'RECEIPT_PENDING',
            },
          }),
        ),
      ).toEqual({
        id: 'n-1',
        type: 'SALE_HOLD_REVIEW',
        title: 'Apartado vencido: revisa la venta',
        body: 'Venta V-000042 · Comprobante pendiente de revisar',
        requestId: null,
        saleId: 's-1',
        backorderId: null,
        createdAt: '2026-11-12T10:00:00.000Z',
        readAt: null,
        folio: 'V-000042',
        subtype: null,
        cause: null,
        reason: null,
        requestOpen: null,
        level: null,
      });
    });

    it('reads an odd payload with nulls instead of failing', () => {
      const view = toNotificationView(
        row({ type: 'SALE_HOLD_REVIEW', requestId: null, payload: null }),
      );
      expect(view).toMatchObject({
        saleId: null,
        folio: null,
        body: '',
        title: 'Apartado vencido: revisa la venta',
      });
    });
  });
  describe('backorder notice (restock-backorder T2b)', () => {
    it.each([
      ['BACKORDER_RESERVED', 'Pedido por reposición apartado'],
      ['BACKORDER_EXPIRED', 'Apartado de pedido por reposición vencido'],
      [
        'BACKORDER_NOTICE_UNDELIVERED',
        'No se pudo avisar al cliente de su pedido por reposición',
      ],
    ])(
      'a %s row names the backorder and its folio; no request or sale fields',
      (type, title) => {
        expect(
          toNotificationView(
            row({
              type,
              requestId: null,
              requestStatus: null,
              payload: {
                backorderId: 'b-1',
                folio: 'BO-000012',
                productName: 'Croquetas',
                variantName: null,
                quantity: 2,
              },
            }),
          ),
        ).toEqual({
          id: 'n-1',
          type,
          title,
          body: expect.stringContaining('BO-000012') as string,
          requestId: null,
          saleId: null,
          backorderId: 'b-1',
          createdAt: '2026-11-12T10:00:00.000Z',
          readAt: null,
          folio: 'BO-000012',
          subtype: null,
          cause: null,
          reason: null,
          requestOpen: null,
          level: null,
        });
      },
    );

    it('reads an odd payload with nulls instead of failing', () => {
      expect(
        toNotificationView(
          row({ type: 'BACKORDER_EXPIRED', requestId: null, payload: null }),
        ),
      ).toMatchObject({ backorderId: null, folio: null, body: '' });
    });
  });
});
