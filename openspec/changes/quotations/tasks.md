# Tasks: Quotations (Cotizaciones)

## Review Workload Forecast

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

## WU1 — Foundation

### RED
- [x] T001. QuotationStatus enum
- [x] T002. Quotation entity lifecycle + lazy expiry
- [x] T003. QuotationItem qty, overridePrice, priceSource
- [x] T004. IQuotationRepository port
- [x] T005. PrismaQuotationRepository round-trip + isolation

### GREEN
- [x] T006. Schema: Quotation, QuotationItem, 3 junctions, enums
- [x] T007. Migrate `add_quotations_tables`
- [x] T008. Quotation + QuotationItem entities
- [x] T009. IQuotationRepository port + errors
- [x] T010. PrismaQuotationRepository

### REFACTOR
- [x] T011. Cleanup + verify green

## WU2 — Service core + draft CRUD

### RED
- [x] T012. openDraft creates DRAFT
- [x] T013. findOne lazy expiry + cross-tenant 404
- [x] T014. findAll paginated + filters
- [x] T015. assignCustomer auto-seeds priceList
- [x] T016. setPriceList triggers recompute (context='QUOTATION')

### GREEN
- [x] T017. 'Quotation' → AppSubjects + PERMISSION_REGISTRY
- [x] T018. QuotationsService (openDraft, findOne, findAll, assignCustomer, setPriceList, recompute)
- [x] T019. Controller + DTOs (Create, AssignCustomer, SetPriceList, Response, ListQuery)
- [x] T020. QuotationsModule DI wiring

### REFACTOR
- [x] T021. Defer shared recompute base (rule-of-three)

## WU3 — Items + promotions + expiry

### RED
- [x] T022. addItem resolves price, no stock check, recompute
- [x] T023. updateItemQuantity rejects qty<1, recompute
- [x] T024. removeItem + recompute
- [x] T025. overrideItemPrice (CUSTOM, recompute)
- [x] T026. apply/removeManualPromotion
- [x] T027. listApplicableManualPromotions
- [x] T028. vetoPromotion
- [x] T029. setExpiry + lazy flip
- [x] T030. cancel + idempotent

### GREEN
- [x] T031. Widen PosEvalInput with context?: 'SALE'|'QUOTATION'
- [x] T032. Add context branch in engine (default SALE)
- [x] T033. Tests: default SALE, QUOTATION==SALE
- [x] T034. Service: addItem, updateItemQuantity, removeItem, overrideItemPrice
- [x] T035. Service: apply/removeManualPromotion, listApplicable, vetoPromotion
- [x] T036. Service: setExpiry, cancel
- [x] T037. Controller: items/promos/expiry/cancel endpoints
- [x] T038. DTOs: AddItem, UpdateQty, OverridePrice, ApplyManualPromo, SetExpiry, Cancel

### REFACTOR
- [x] T039. Confirm recompute idempotency

## WU4 — PDF + email + send

### RED
- [ ] T040. QuotationPdf renders "COTIZACIÓN", no payment
- [ ] T041. renderQuotationPdf stream + unknown format
- [ ] T042. send() flips SENT on Resend success
- [ ] T043. send() 422 on customer.email=null
- [ ] T044. send() 502 on Resend fail (atomic)
- [ ] T045. send() 409 non-DRAFT, 422 empty
- [ ] T046. PDF preview DRAFT/SENT/EXPIRED
- [ ] T047. QuotationEmail + MAILER.send attachment

### GREEN
- [ ] T048. Extend FormatKey with 'quotation-a4'
- [ ] T049. QuotationPdf.tsx + registry (drop payment/cambio)
- [ ] T050. renderQuotationPdf in service + GET /quotations/:id/pdf route
- [ ] T051. Import QuotationsModule in PdfGenerationModule
- [ ] T052. QuotationEmail.tsx
- [ ] T053. QuotationsService.send() (atomic PDF+mail+SENT)
- [ ] T054. POST /quotations/drafts/:id/send endpoint

### REFACTOR
- [ ] T055. Extract shared template header/footer if needed
