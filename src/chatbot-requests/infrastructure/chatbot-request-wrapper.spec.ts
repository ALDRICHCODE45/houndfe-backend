import {
  humanDecisionWrap,
  NO_CUSTOMER,
  STAFF_ONLY_REQUEST_ORIGIN,
  WRAP_SOURCE,
} from './chatbot-request-wrapper';

const DECISION = {
  id: 'd-1',
  type: 'RESTOCK' as const,
  productId: 'p-1',
  productName: 'Croquetas',
  variantId: null,
};

describe('humanDecisionWrap', () => {
  it('keeps the wrapper of every ordinary RESTOCK / EXPIRATION exactly as before', () => {
    expect(humanDecisionWrap(DECISION)).toEqual({
      subtype: 'RESTOCK',
      source: WRAP_SOURCE.humanDecision,
      wrappedId: 'd-1',
      fallbackKey: 'unknown:d-1',
      summary: 'Stock: Croquetas',
      context: { productId: 'p-1', variantId: null },
      link: NO_CUSTOMER,
      wrapped: { humanDecisionId: 'd-1' },
    });
    expect(humanDecisionWrap({ ...DECISION, type: 'EXPIRATION' }).summary).toBe(
      'Caducidad: Croquetas',
    );
    // An explicit empty / false option is the same ordinary wrapper.
    expect(humanDecisionWrap(DECISION, { staffOnly: false })).toEqual(
      humanDecisionWrap(DECISION),
    );
  });

  it('marks a server-created re-estimate (staff-only): origin in the context and a recognisable summary, still no customer and no conversation', () => {
    const wrap = humanDecisionWrap(DECISION, { staffOnly: true });
    expect(wrap.context).toEqual({
      productId: 'p-1',
      variantId: null,
      origin: STAFF_ONLY_REQUEST_ORIGIN,
    });
    expect(wrap.summary).toBe('Reposición vencida: Croquetas');
    expect(wrap.link).toBe(NO_CUSTOMER);
    expect(wrap.conversationRef).toBeUndefined();
    expect(wrap.source).toBe(WRAP_SOURCE.humanDecision);
  });
});
