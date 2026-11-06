/**
 * shipping-zones / T3 (S7) — shipping credit.
 *
 * "$120 MXN por artículo de más de $500", counted per UNIT. A line's unit
 * price after discounts is its repriced total (`finalPriceCents`, promotions
 * and order discounts included) divided by its quantity; when it is strictly
 * above the threshold, every unit of the line earns the credit. Credits add
 * up, the applied credit never exceeds the cost, and the customer pays
 * max(0, cost − credit).
 *
 * Whether the credit also covers an own-zone SURCHARGE is POR CONFIRMAR by
 * the owner (provisionally yes), so it is the `appliesToSurcharge` switch.
 */

export interface ShippingCreditRule {
  perUnitCreditCents: number;
  /** A unit earns the credit when its price is strictly above this. */
  unitPriceThresholdCents: number;
  appliesToSurcharge: boolean;
}

export const DEFAULT_SHIPPING_CREDIT_RULE: ShippingCreditRule = {
  perUnitCreditCents: 12000,
  unitPriceThresholdCents: 50000,
  appliesToSurcharge: true,
};

export interface CreditLine {
  quantity: number;
  /** Line total after every discount, from the sale repricing. */
  finalPriceCents: number;
}

export function computeShippingCredit(
  lines: readonly CreditLine[],
  rule: ShippingCreditRule,
): number {
  return lines.reduce(
    (sum, line) =>
      // unit price > threshold  ⇔  line total > threshold × quantity
      line.finalPriceCents > rule.unitPriceThresholdCents * line.quantity
        ? sum + rule.perUnitCreditCents * line.quantity
        : sum,
    0,
  );
}

export interface ShippingCharge {
  costCents: number;
  /** Credit actually applied: min(earned credit, cost), 0 when not applicable. */
  creditCents: number;
  customerChargeCents: number;
}

export function applyShippingCredit(
  input: { costCents: number; creditCents: number },
  applies: boolean,
): ShippingCharge {
  const creditCents = applies
    ? Math.min(input.creditCents, input.costCents)
    : 0;
  return {
    costCents: input.costCents,
    creditCents,
    customerChargeCents: input.costCents - creditCents,
  };
}
