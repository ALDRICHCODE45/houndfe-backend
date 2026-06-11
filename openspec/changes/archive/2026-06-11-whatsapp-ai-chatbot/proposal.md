# Proposal: WhatsApp AI Sales Chatbot Program

## Intent

Build a HoundFe-only WhatsApp AI chatbot that augments/replaces human agents and closes sales 24/7 in the custom POS. HoundFe's backend remains the transaction source of truth.

## Scope

### Program Scope
- Hybrid topology: `src/chatbot-api/` here + separate chatbot VPS.
- Meta Cloud API direct; verification and number strategy start day one.
- State machine controls transactions; LLM handles conversation.
- Skydropx behind `ShippingQuoteProvider`; CDMX free shipping/promotions can alter final price.
- Transfer payment v1: collect receipt image, attach to sale, human confirms, POS marks paid/closed.
- LLM spend MUST stay under US$200/month: instrument cost; capable model only for images/ambiguity.

### First Slice: `chatbot-api-foundation`
- Authenticated internal chatbot API.
- Catalog search/detail, stock/price, cart validation, customer phone lookup/create, address support, sale registration.
- Reuse existing domain logic; "tenant" means HoundFe branch, not SaaS customer.

### Out of Scope
- SaaS multi-tenancy or external merchant onboarding.
- Payment processing; auto receipt validation/OCR/bank reconciliation in v1.
- Voice notes/audio; defer until text/image flow proves value.
- Full WhatsApp bot implementation in the first slice.

## Capabilities

### New Capabilities
- `chatbot-api-foundation`: Internal catalog, customer, cart, and sale contract.

### Modified Capabilities
- None; no existing OpenSpec specs are present.

## Approach

This frames the program and first actionable SDD. Future SDDs: WhatsApp webhook echo, conversation persistence, catalog Q&A, cart/order, promotion evaluation, Skydropx quotes, payment confirmation, image recognition, human handoff, templates/follow-up. `public-catalog-whatsapp-order` is superseded/absorbed; the catalog may still link to WhatsApp, but structured `wa.me` payloads are no longer the strategy.

## Preconditions

- Meta verification/WhatsApp number decision.
- Skydropx sandbox, LLM keys, separate VPS, API secrets.
- Conversations pending for tone/flow; not an early blocker.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/chatbot-api/` | New | API-key internal API. |
| `src/public-catalog/` | Modified | Bot-safe catalog/cart. |
| `src/customers/` | Modified | Phone lookup/create. |
| `src/sales/` | Modified | `ONLINE` transfer sales. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Meta delay | High | Start day one; use sandbox. |
| LLM overrun | Med | US$200 cap, per-call metrics. |
| Payment error/fraud | Med | Human confirmation; no auto validation. |
| POS instability | Low | Separate VPS; thin backend API. |

## Rollback Plan

Disable the chatbot API key and stop the separate service. Existing POS flows remain unchanged; bot drafts can be reviewed/cancelled manually.

## Success Criteria

- [ ] Authenticated bot endpoints require no JWT user.
- [ ] Bot responses expose no cost/margin/supplier fields.
- [ ] Bot-facing APIs register a sale through existing aggregates.
- [ ] Preconditions are tracked before WhatsApp-dependent slices.
