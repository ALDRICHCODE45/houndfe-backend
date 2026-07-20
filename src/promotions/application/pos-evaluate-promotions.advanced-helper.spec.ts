/**
 * WU2 — Pure helper `computeAdvancedReward` (RED-first).
 *
 * Contract (design.md Decision 2; spec.md:60-91,102-106):
 *   export function computeAdvancedReward(i: {
 *     totalBuyMatchedQty;         // Σ quantity across all BUY-side matches
 *     buyQuantity;                // N — units the customer must buy
 *     getQuantity;                // M — units the customer receives at a discount per reward group
 *     getDiscountPercent;         // 0..100 — discount applied to M get-units
 *     getCandidateLines: Array<{ itemId; effectiveUnitPriceCents; quantity }>;
 *   }): {
 *     rewardGroupCount;            // floor(totalBuyMatchedQty / buyQuantity)
 *     rewards: Array<{
 *       itemId; discountedUnitCount; perUnitRewardCents; lineDiscountCents;
 *     }>;
 *   }
 *
 *   rewardGroupCount  = floor(totalBuyMatchedQty / buyQuantity)
 *   totalDiscountedUnits = rewardGroupCount * getQuantity
 *   perUnitRewardCents = Math.round((effectiveUnitPriceCents * getDiscountPercent) / 100)
 *
 * Multi-GET-line allocation is deterministic lowest-`itemId` ascending
 * (spec.md resolution: cheapest-first is a deferred follow-up). The
 * helper sorts the candidate lines by `itemId` asc and walks them in
 * that order until the reward group's `getQuantity` units have been
 * allocated. Each line gets a `discountedUnitCount` capped at the
 * line's own `quantity` (the unit-pool can't exceed what's on the
 * line — same invariant as the receipt mapper).
 *
 * The helper is pure — no mocks, no I/O, no DI. Co-located in
 * pos-evaluate-promotions.use-case.ts so the engine and its unit
 * tests import the same module symbol.
 *
 * Scenarios locked here:
 *   - single-group:    buy6/3 → 1 group, single GET line gets M units
 *   - S2 multi-group:  buy6/3 → 2 groups × M=1 = 2 units discounted
 *   - zero-group:      totalBuyMatchedQty below buyQuantity → zero reward
 *   - 100% true-free:  perUnit=eff (Math.round(1000*100/100)=1000), line saves full
 *   - >100 NOT reachable here: the entity caps the promo at 100 (D3 lift);
 *     the helper trusts the caller and computes whatever percent lands.
 *   - rounding:        Math.round((eff*pct)/100) is the engine convention
 *   - multi-getQuantity: M>1 reward group discounts M units on a single GET line
 *   - multi-GET-line lowest-itemId: rewards distributed by itemId asc
 */
import { computeAdvancedReward } from './pos-evaluate-promotions.use-case';

describe('computeAdvancedReward (WU2) — pure helper', () => {
  describe('single-group case', () => {
    it('totalBuyMatchedQty=3, buyQuantity=3, getQuantity=1, getDiscountPercent=50 → 1 group, 1 unit discounted, perUnit 500c, line 500c', () => {
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 3,
        buyQuantity: 3,
        getQuantity: 1,
        getDiscountPercent: 50,
        getCandidateLines: [
          { itemId: 'item-get', effectiveUnitPriceCents: 1000, quantity: 1 },
        ],
      });

      expect(result.rewardGroupCount).toBe(1);
      expect(result.rewards).toEqual([
        {
          itemId: 'item-get',
          discountedUnitCount: 1,
          perUnitRewardCents: 500,
          lineDiscountCents: 500,
        },
      ]);
    });
  });

  describe('multi-group case (S2 spec scenario)', () => {
    it('totalBuyMatchedQty=6, buyQuantity=3, getQuantity=1, getDiscountPercent=30 → 2 groups, 2 units discounted, line 600c', () => {
      // spec.md:96-100 — buy 3 from Candles, get 1 of Holder-X at 30%
      // on 6 × Candle + 3 × Holder-X at 1000c. floor(6/3) = 2 reward
      // applications × 1 unit × Math.round((1000*30)/100) = 300c → 600c.
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 6,
        buyQuantity: 3,
        getQuantity: 1,
        getDiscountPercent: 30,
        getCandidateLines: [
          {
            itemId: 'item-holder-x',
            effectiveUnitPriceCents: 1000,
            quantity: 3,
          },
        ],
      });

      expect(result.rewardGroupCount).toBe(2);
      expect(result.rewards).toEqual([
        {
          itemId: 'item-holder-x',
          discountedUnitCount: 2,
          perUnitRewardCents: 300,
          lineDiscountCents: 600,
        },
      ]);
    });

    it('totalBuyMatchedQty=9, buyQuantity=3, getQuantity=1 → 3 groups, 3 units, line 1500c (3 × 500c per group)', () => {
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 9,
        buyQuantity: 3,
        getQuantity: 1,
        getDiscountPercent: 50,
        getCandidateLines: [
          { itemId: 'item-get', effectiveUnitPriceCents: 1000, quantity: 3 },
        ],
      });

      expect(result.rewardGroupCount).toBe(3);
      expect(result.rewards).toEqual([
        {
          itemId: 'item-get',
          discountedUnitCount: 3,
          perUnitRewardCents: 500,
          lineDiscountCents: 1500,
        },
      ]);
    });
  });

  describe('zero-group case — floor(totalBuyMatchedQty / buyQuantity) == 0', () => {
    it('totalBuyMatchedQty=2, buyQuantity=3 → 0 groups, no rewards emitted', () => {
      // spec.md:103-106 — BUY count below buyQuantity yields zero
      // reward groups. The helper returns an empty rewards array AND
      // a zero rewardGroupCount.
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 2,
        buyQuantity: 3,
        getQuantity: 1,
        getDiscountPercent: 50,
        getCandidateLines: [
          { itemId: 'item-get', effectiveUnitPriceCents: 1000, quantity: 1 },
        ],
      });

      expect(result.rewardGroupCount).toBe(0);
      expect(result.rewards).toEqual([]);
    });

    it('totalBuyMatchedQty=0 → 0 groups, no rewards', () => {
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 0,
        buyQuantity: 3,
        getQuantity: 1,
        getDiscountPercent: 50,
        getCandidateLines: [
          { itemId: 'item-get', effectiveUnitPriceCents: 1000, quantity: 1 },
        ],
      });

      expect(result.rewardGroupCount).toBe(0);
      expect(result.rewards).toEqual([]);
    });
  });

  describe('100% getDiscountPercent — true free GET unit (D3)', () => {
    it('1 group, getQuantity=1, getDiscountPercent=100 → perUnit equals effectiveUnitPriceCents, full free unit', () => {
      // spec.md:111-116 — D3 lifts the prior 99 cap. 100% yields
      // a true free GET unit. Math.round(1000*100/100) = 1000.
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 3,
        buyQuantity: 3,
        getQuantity: 1,
        getDiscountPercent: 100,
        getCandidateLines: [
          { itemId: 'item-get', effectiveUnitPriceCents: 1000, quantity: 1 },
        ],
      });

      expect(result.rewardGroupCount).toBe(1);
      expect(result.rewards[0].perUnitRewardCents).toBe(1000);
      expect(result.rewards[0].lineDiscountCents).toBe(1000);
    });
  });

  describe('per-unit Math.round rounding (Q8 convention)', () => {
    it('getDiscountPercent=33 on 100c unit → perUnit = Math.round((100*33)/100) = 33c', () => {
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 1,
        buyQuantity: 1,
        getQuantity: 1,
        getDiscountPercent: 33,
        getCandidateLines: [
          { itemId: 'item-get', effectiveUnitPriceCents: 100, quantity: 1 },
        ],
      });

      expect(result.rewards[0].perUnitRewardCents).toBe(33);
      expect(result.rewards[0].lineDiscountCents).toBe(33);
    });

    it('getDiscountPercent=17 on 333c unit → perUnit = Math.round((333*17)/100) = 57c (rounds 56.61 up)', () => {
      // Locks the engine convention: Math.round, not floor/truncate.
      // (333 * 17) / 100 = 56.61 → Math.round = 57.
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 1,
        buyQuantity: 1,
        getQuantity: 1,
        getDiscountPercent: 17,
        getCandidateLines: [
          { itemId: 'item-get', effectiveUnitPriceCents: 333, quantity: 1 },
        ],
      });

      expect(result.rewards[0].perUnitRewardCents).toBe(57);
      expect(result.rewards[0].lineDiscountCents).toBe(57);
    });
  });

  describe('multi-getQuantity — M > 1 reward group discounts M units on a single GET line', () => {
    it('getQuantity=2, 1 group → 2 units discounted on a single GET line', () => {
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 3,
        buyQuantity: 3,
        getQuantity: 2,
        getDiscountPercent: 50,
        getCandidateLines: [
          { itemId: 'item-get', effectiveUnitPriceCents: 1000, quantity: 2 },
        ],
      });

      expect(result.rewardGroupCount).toBe(1);
      expect(result.rewards).toEqual([
        {
          itemId: 'item-get',
          discountedUnitCount: 2,
          perUnitRewardCents: 500,
          lineDiscountCents: 1000,
        },
      ]);
    });

    it('getQuantity=2, 2 groups → 4 units discounted on a single GET line, perUnit 500c, line 2000c', () => {
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 6,
        buyQuantity: 3,
        getQuantity: 2,
        getDiscountPercent: 50,
        getCandidateLines: [
          { itemId: 'item-get', effectiveUnitPriceCents: 1000, quantity: 4 },
        ],
      });

      expect(result.rewardGroupCount).toBe(2);
      expect(result.rewards[0]).toEqual({
        itemId: 'item-get',
        discountedUnitCount: 4,
        perUnitRewardCents: 500,
        lineDiscountCents: 2000,
      });
    });
  });

  describe('multi-GET-line allocation — deterministic lowest-itemId asc', () => {
    it('3 groups × 1 unit allocated across 3 GET lines sorted by itemId asc', () => {
      // design.md "Open Questions resolved" — multi-GET-line uses
      // deterministic lowest-itemId ascending. Here we feed the
      // helper a candidate list NOT in sorted order and assert the
      // allocation is itemId-asc.
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 9,
        buyQuantity: 3,
        getQuantity: 1,
        getDiscountPercent: 50,
        getCandidateLines: [
          // Deliberately out of order — the helper MUST sort.
          { itemId: 'item-Z', effectiveUnitPriceCents: 1000, quantity: 1 },
          { itemId: 'item-A', effectiveUnitPriceCents: 1000, quantity: 1 },
          { itemId: 'item-M', effectiveUnitPriceCents: 1000, quantity: 1 },
        ],
      });

      expect(result.rewardGroupCount).toBe(3);
      // Allocated in itemId ascending order: A, M, Z.
      expect(result.rewards).toEqual([
        {
          itemId: 'item-A',
          discountedUnitCount: 1,
          perUnitRewardCents: 500,
          lineDiscountCents: 500,
        },
        {
          itemId: 'item-M',
          discountedUnitCount: 1,
          perUnitRewardCents: 500,
          lineDiscountCents: 500,
        },
        {
          itemId: 'item-Z',
          discountedUnitCount: 1,
          perUnitRewardCents: 500,
          lineDiscountCents: 500,
        },
      ]);
    });

    it('allocates more than 1 unit to a line when getQuantity > remaining items (caps at line.quantity)', () => {
      // getQuantity=2 with only one GET candidate line — both units
      // go to that single line (capped at line.quantity when not
      // enough distinct lines exist).
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 3,
        buyQuantity: 3,
        getQuantity: 2,
        getDiscountPercent: 50,
        getCandidateLines: [
          { itemId: 'item-A', effectiveUnitPriceCents: 1000, quantity: 2 },
        ],
      });

      expect(result.rewardGroupCount).toBe(1);
      expect(result.rewards).toEqual([
        {
          itemId: 'item-A',
          discountedUnitCount: 2,
          perUnitRewardCents: 500,
          lineDiscountCents: 1000,
        },
      ]);
    });

    it('spreads across two GET lines when getQuantity exceeds a single line.quantity', () => {
      // getQuantity=2 but line A has quantity=1 → 1 unit on A, 1 unit on B.
      const result = computeAdvancedReward({
        totalBuyMatchedQty: 3,
        buyQuantity: 3,
        getQuantity: 2,
        getDiscountPercent: 50,
        getCandidateLines: [
          { itemId: 'item-B', effectiveUnitPriceCents: 1000, quantity: 1 },
          { itemId: 'item-A', effectiveUnitPriceCents: 1000, quantity: 1 },
        ],
      });

      expect(result.rewardGroupCount).toBe(1);
      expect(result.rewards).toEqual([
        {
          itemId: 'item-A',
          discountedUnitCount: 1,
          perUnitRewardCents: 500,
          lineDiscountCents: 500,
        },
        {
          itemId: 'item-B',
          discountedUnitCount: 1,
          perUnitRewardCents: 500,
          lineDiscountCents: 500,
        },
      ]);
    });
  });
});
