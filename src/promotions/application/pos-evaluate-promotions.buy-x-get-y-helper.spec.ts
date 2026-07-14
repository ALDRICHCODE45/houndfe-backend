/**
 * WU1 — Pure helper `computeBuyXGetYReward` (RED-first).
 *
 * Contract (design.md Decision 2; spec.md:60-91,102-106):
 *   export function computeBuyXGetYReward(i: {
 *     quantity; effectiveUnitPriceCents; buyQuantity (N); getQuantity (M); getDiscountPercent (0..100);
 *   }): {
 *     rewardGroups; discountedUnitCount; perUnitRewardCents; lineDiscountCents;
 *   }
 *
 *   groupSize         = N + M
 *   rewardGroups      = floor(quantity / groupSize)         // Q3 + Q9 (zero group when qty < N+M)
 *   discountedUnitCount = rewardGroups * M
 *   perUnitRewardCents  = Math.round((unitPrice * getDiscountPercent) / 100)  // Q8
 *   lineDiscountCents    = discountedUnitCount * perUnitRewardCents
 *
 * The helper is pure — no mocks, no I/O, no DI. Co-located in
 * pos-evaluate-promotions.use-case.ts so the engine and its unit
 * tests import the same module symbol.
 *
 * Scenarios locked here (traced to spec.md):
 *   - qty3/1000c/2+1/50   : one group, 500c line saving (spec.md:74-78)
 *   - qty6/1000c/2+1/50   : two groups, 1000c line saving (spec.md:79-83)
 *   - qty2/1000c/2+1/50   : qty at buyQuantity but < N+M → ZERO groups (spec.md:69-72)
 *   - qty3/1000c/2+1/100  : 100% — true free get-unit, perUnit=1000 (spec.md:97-106)
 *   - qty2/100c/1+1/33    : per-unit Math.round rounding (spec.md:88-91)
 *   - qty4/777c/3+2/10    : oddball — verifies the math holds for non-round numbers
 */
import { computeBuyXGetYReward } from './pos-evaluate-promotions.use-case';

describe('computeBuyXGetYReward (WU1) — pure helper', () => {
  describe('basic one-group case (spec.md:74-78)', () => {
    it('qty 3, 1000c/unit, buy 2 get 1 @ 50% → 1 group, 1 get-unit, perUnit 500c, line 500c', () => {
      const result = computeBuyXGetYReward({
        quantity: 3,
        effectiveUnitPriceCents: 1000,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });

      expect(result).toEqual({
        rewardGroups: 1,
        discountedUnitCount: 1,
        perUnitRewardCents: 500,
        lineDiscountCents: 500,
      });
    });
  });

  describe('multi-group case (spec.md:79-83)', () => {
    it('qty 6, 1000c/unit, buy 2 get 1 @ 50% → 2 groups, 2 get-units, perUnit 500c, line 1000c', () => {
      const result = computeBuyXGetYReward({
        quantity: 6,
        effectiveUnitPriceCents: 1000,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });

      expect(result).toEqual({
        rewardGroups: 2,
        discountedUnitCount: 2,
        perUnitRewardCents: 500,
        lineDiscountCents: 1000,
      });
    });

    it('qty 9, 1000c/unit, buy 2 get 1 @ 50% → 3 groups (exact multiple)', () => {
      const result = computeBuyXGetYReward({
        quantity: 9,
        effectiveUnitPriceCents: 1000,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });

      expect(result).toEqual({
        rewardGroups: 3,
        discountedUnitCount: 3,
        perUnitRewardCents: 500,
        lineDiscountCents: 1500,
      });
    });

    it('qty 7, 1000c/unit, buy 2 get 1 @ 50% → floor(7/3)=2 groups (qty beyond last full group yields nothing)', () => {
      const result = computeBuyXGetYReward({
        quantity: 7,
        effectiveUnitPriceCents: 1000,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });

      expect(result.rewardGroups).toBe(2);
      expect(result.discountedUnitCount).toBe(2);
      expect(result.lineDiscountCents).toBe(1000);
    });
  });

  describe('zero-group case (spec.md:69-72) — qty at buyQuantity but below N+M', () => {
    it('qty 2, 1000c/unit, buy 2 get 1 @ 50% → 0 groups, 0 get-units, line 0c', () => {
      const result = computeBuyXGetYReward({
        quantity: 2,
        effectiveUnitPriceCents: 1000,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });

      expect(result).toEqual({
        rewardGroups: 0,
        discountedUnitCount: 0,
        perUnitRewardCents: 500,
        lineDiscountCents: 0,
      });
    });

    it('qty 1, 1000c/unit, buy 2 get 1 @ 50% → 0 groups (below buyQuantity, no eligibility) — still zero reward', () => {
      // The engine gates on `quantity >= buyQuantity` BEFORE calling the
      // helper (spec.md:64-67), but the helper itself must be safe for any
      // non-negative qty and yield zero reward for any qty < groupSize.
      const result = computeBuyXGetYReward({
        quantity: 1,
        effectiveUnitPriceCents: 1000,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 50,
      });

      expect(result.rewardGroups).toBe(0);
      expect(result.discountedUnitCount).toBe(0);
      expect(result.lineDiscountCents).toBe(0);
    });
  });

  describe('100% getDiscountPercent (spec.md:97-106) — true free get-unit', () => {
    it('qty 3, 1000c/unit, buy 2 get 1 @ 100% → perUnit 1000c, line 1000c (one full free unit)', () => {
      const result = computeBuyXGetYReward({
        quantity: 3,
        effectiveUnitPriceCents: 1000,
        buyQuantity: 2,
        getQuantity: 1,
        getDiscountPercent: 100,
      });

      expect(result).toEqual({
        rewardGroups: 1,
        discountedUnitCount: 1,
        perUnitRewardCents: 1000,
        lineDiscountCents: 1000,
      });
    });

    it('qty 8, 500c/unit, buy 2 get 2 @ 100% → 2 full groups, 4 get-units free, perUnit 500c, line 2000c', () => {
      // qty 6 / (2+2)=4 → floor=1 group (4 get-units from 8 buy-eligible? no —
      // floor(6/4)=1, so 1 group × M=2 get-units). To exercise TWO groups
      // we need qty ≥ 8. Locks groupSize behavior on a 3x2-style deal.
      const result = computeBuyXGetYReward({
        quantity: 8,
        effectiveUnitPriceCents: 500,
        buyQuantity: 2,
        getQuantity: 2,
        getDiscountPercent: 100,
      });

      expect(result).toEqual({
        rewardGroups: 2,
        discountedUnitCount: 4,
        perUnitRewardCents: 500,
        lineDiscountCents: 2000,
      });
    });
  });

  describe('per-unit Math.round rounding (spec.md:88-91 — Q8)', () => {
    it('qty 2, 100c/unit, buy 1 get 1 @ 33% → perUnit Math.round((100*33)/100) = 33c, line 33c', () => {
      const result = computeBuyXGetYReward({
        quantity: 2,
        effectiveUnitPriceCents: 100,
        buyQuantity: 1,
        getQuantity: 1,
        getDiscountPercent: 33,
      });

      expect(result).toEqual({
        rewardGroups: 1,
        discountedUnitCount: 1,
        perUnitRewardCents: 33,
        lineDiscountCents: 33,
      });
    });

    it('qty 3, 333c/unit, buy 1 get 1 @ 17% → perUnit Math.round((333*17)/100) = 57c (rounds 56.61 up)', () => {
      // Locks the engine convention: Math.round, not floor/truncate.
      // (333 * 17) / 100 = 56.61 → Math.round = 57.
      const result = computeBuyXGetYReward({
        quantity: 2,
        effectiveUnitPriceCents: 333,
        buyQuantity: 1,
        getQuantity: 1,
        getDiscountPercent: 17,
      });

      expect(result.perUnitRewardCents).toBe(57);
      expect(result.lineDiscountCents).toBe(57);
    });
  });

  describe('sanity — non-round numbers', () => {
    it('qty 4, 777c/unit, buy 3 get 2 @ 10% → 0 groups (qty 4 < groupSize 5), perUnit 78c, line 0c', () => {
      // floor(4 / (3+2)) = 0 → zero reward (qty 4 < groupSize 5). Verifies
      // the floor math on a borderline qty where the user might expect
      // at least one group.
      const result = computeBuyXGetYReward({
        quantity: 4,
        effectiveUnitPriceCents: 777,
        buyQuantity: 3,
        getQuantity: 2,
        getDiscountPercent: 10,
      });

      expect(result).toEqual({
        rewardGroups: 0,
        discountedUnitCount: 0,
        perUnitRewardCents: Math.round((777 * 10) / 100),
        lineDiscountCents: 0,
      });
    });

    it('qty 10, 777c/unit, buy 3 get 2 @ 10% → 2 groups, 4 get-units, perUnit 78c, line 312c', () => {
      const result = computeBuyXGetYReward({
        quantity: 10,
        effectiveUnitPriceCents: 777,
        buyQuantity: 3,
        getQuantity: 2,
        getDiscountPercent: 10,
      });

      expect(result).toEqual({
        rewardGroups: 2,
        discountedUnitCount: 4,
        perUnitRewardCents: 78,
        lineDiscountCents: 312,
      });
    });
  });
});
