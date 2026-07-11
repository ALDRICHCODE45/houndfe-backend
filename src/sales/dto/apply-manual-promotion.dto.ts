/**
 * Work Unit 6 — POST /sales/drafts/:id/manual-promotions/:promotionId
 *
 * The apply operation takes its inputs from the URL (sale id +
 * promotion id). The body is intentionally empty — there is nothing
 * for the seller to supply beyond the path params. This DTO exists
 * for future-proofing (e.g., a future `note` field for the audit
 * trail) and so the route signature stays consistent with the rest
 * of the controller (which uses class-validator-decorated bodies).
 */
export class ApplyManualPromotionDto {}
