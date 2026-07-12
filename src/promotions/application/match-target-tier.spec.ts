/**
 * W3 — Shared `matchTargetTier` pure helper (RED-first).
 *
 * Contract (design.md "Shared Match Helper"):
 *   export type LineMatchTier = 'VARIANT' | 'PRODUCT' | null;
 *   export function matchTargetTier(
 *     targetItems: ReadonlyArray<{ side: string; targetType: string; targetId: string }>,
 *     line: { productId: string; variantId: string | null },
 *   ): LineMatchTier
 *
 * Tier semantics:
 *   - 'VARIANT' : a target item on side=DEFAULT, targetType=VARIANTS hit
 *                 the line's variantId.
 *   - 'PRODUCT' : no VARIANTS hit, but a target item on side=DEFAULT,
 *                 targetType=PRODUCTS hit the line's productId.
 *   - null      : neither matched.
 *
 * Spec scenarios exercised:
 *   1. PRODUCTS targeting matches by product id
 *   2. CATEGORIES targeting matches by category id (returns null — out of
 *      slice per spec, but the helper still returns null cleanly).
 *   3. PRODUCTS still matches every variant of a variant-bearing product
 *   4. VARIANTS matches only the exact variant
 *   7. Combined VARIANTS+V-B + PRODUCTS+P1 promo on V-A line → 'VARIANT'
 *
 * Pure helper: zero mocks, zero side effects. This is the DRY core that
 * BOTH match sites (pickBestPerLine AND targetableManualPromotionIds)
 * will call, so the spec scenarios for the helper MUST come from the
 * spec's matcher requirements (1-4, 7) — NOT the precedence scenarios
 * (5,6,8,9), which live in W4.
 */
import {
  matchTargetTier,
  type LineMatchTier,
} from '../application/pos-evaluate-promotions.use-case';

interface MiniTargetItem {
  side: string;
  targetType: string;
  targetId: string;
}

interface MiniLine {
  productId: string;
  variantId: string | null;
}

describe('matchTargetTier (W3) — pure helper', () => {
  describe('PRODUCTS targeting (scenarios 1, 3)', () => {
    it('returns "PRODUCT" when a PRODUCTS-typed target hits the line productId', () => {
      const result: LineMatchTier = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' }],
        { productId: 'P1', variantId: 'V-A' },
      );
      expect(result).toBe('PRODUCT');
    });

    it('returns "PRODUCT" for a variant-bearing line when the parent product matches (every-variant match)', () => {
      // Scenario 3: PRODUCTS on P1, V-A line (variantId present) → still
      // matches because the helper falls back to PRODUCTS when there is
      // no VARIANTS hit. This is the back-compat guarantee.
      const aResult = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' }],
        { productId: 'P1', variantId: 'V-A' },
      );
      expect(aResult).toBe('PRODUCT');

      const bResult = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' }],
        { productId: 'P1', variantId: 'V-B' },
      );
      expect(bResult).toBe('PRODUCT');
    });

    it('returns null when a PRODUCTS-typed target does NOT hit the line productId (scenario 1, the negative side)', () => {
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' }],
        { productId: 'P2', variantId: null },
      );
      expect(result).toBeNull();
    });
  });

  describe('VARIANTS targeting (scenario 4)', () => {
    it('returns "VARIANT" when a VARIANTS-typed target hits the line variantId', () => {
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'VARIANTS', targetId: 'V-A' }],
        { productId: 'P1', variantId: 'V-A' },
      );
      expect(result).toBe('VARIANT');
    });

    it('returns null when a VARIANTS-typed target does NOT hit the line variantId', () => {
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'VARIANTS', targetId: 'V-A' }],
        { productId: 'P1', variantId: 'V-B' },
      );
      expect(result).toBeNull();
    });

    it('returns null when the line has no variantId (variantId === null) — VARIANTS requires a variant', () => {
      // Defensive: a VARIANTS target cannot match a line without a
      // variantId (no variant to compare against). The pure helper
      // makes this guarantee structural.
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'VARIANTS', targetId: 'V-A' }],
        { productId: 'P1', variantId: null },
      );
      expect(result).toBeNull();
    });
  });

  describe('CATEGORIES / BRANDS targeting (out of slice, must NOT match)', () => {
    it('returns null for a CATEGORIES-typed target even if line.productId is set', () => {
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'CATEGORIES', targetId: 'CAT1' }],
        { productId: 'P1', variantId: 'V-A' },
      );
      expect(result).toBeNull();
    });

    it('returns null for a BRANDS-typed target even if line.productId is set', () => {
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' }],
        { productId: 'P1', variantId: 'V-A' },
      );
      expect(result).toBeNull();
    });
  });

  describe('Specificity rule (scenario 7) — VARIANTS wins over PRODUCTS when both hit', () => {
    it('returns "VARIANT" when both a VARIANTS-typed target (V-A) and a PRODUCTS-typed target (P1) match the same V-A line', () => {
      // A promo that targets BOTH V-A (VARIANTS) and P1 (PRODUCTS).
      // Applied to a V-A line, the helper MUST report VARIANT so the
      // precedence pre-pass drops the PRODUCT candidate.
      const items: MiniTargetItem[] = [
        { side: 'DEFAULT', targetType: 'VARIANTS', targetId: 'V-A' },
        { side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' },
      ];
      const result = matchTargetTier(items, {
        productId: 'P1',
        variantId: 'V-A',
      });
      expect(result).toBe('VARIANT');
    });

    it('returns "VARIANT" when VARIANTS-typed target is V-B (not on this V-A line) — then VARIANTS does NOT match, PRODUCTS wins', () => {
      // Variant-typed target V-B does NOT match a V-A line, so the
      // helper should fall through to PRODUCTS on P1.
      const items: MiniTargetItem[] = [
        { side: 'DEFAULT', targetType: 'VARIANTS', targetId: 'V-B' },
        { side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' },
      ];
      const result = matchTargetTier(items, {
        productId: 'P1',
        variantId: 'V-A',
      });
      expect(result).toBe('PRODUCT');
    });
  });

  describe('side discriminator', () => {
    it('ignores non-DEFAULT-side targets (BUY/GET for BUY_X_GET_Y / ADVANCED)', () => {
      // The engine only matches DEFAULT-side targets for PRODUCT_DISCOUNT.
      // BUY/GET rows belong to BUY_X_GET_Y / ADVANCED which the engine
      // never applies.
      const items: MiniTargetItem[] = [
        { side: 'BUY', targetType: 'PRODUCTS', targetId: 'P1' },
        { side: 'GET', targetType: 'PRODUCTS', targetId: 'P1' },
      ];
      const result = matchTargetTier(items, {
        productId: 'P1',
        variantId: null,
      });
      expect(result).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('returns null when targetItems is empty', () => {
      const result = matchTargetTier<MiniTargetItem, MiniLine>([], {
        productId: 'P1',
        variantId: 'V-A',
      });
      expect(result).toBeNull();
    });

    it('only the matching side matters — non-matching side does NOT cancel the matching one', () => {
      const items: MiniTargetItem[] = [
        { side: 'BUY', targetType: 'VARIANTS', targetId: 'V-A' }, // wrong side
        { side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' }, // matches
      ];
      const result = matchTargetTier(items, {
        productId: 'P1',
        variantId: 'V-A',
      });
      expect(result).toBe('PRODUCT');
    });
  });
});