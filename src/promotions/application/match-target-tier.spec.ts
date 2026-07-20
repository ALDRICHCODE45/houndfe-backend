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
  /**
   * Optional resolved product.categoryId/brandId — populated by the
   * caller (SalesService.buildPosEvalInput) AFTER batch-resolving
   * the line's product via ProductsService.resolveProductCategoryBrandIds.
   * NOT used by the existing PRODUCTS/VARIANTS branches; only the
   * CATEGORIES/BRANDS branches read them.
   */
  categoryId?: string | null;
  brandId?: string | null;
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

  describe('CATEGORIES targeting (scenario 2)', () => {
    it('returns "CATEGORY" when a CATEGORIES-typed target hits line.categoryId', () => {
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'CATEGORIES', targetId: 'CAT1' }],
        {
          productId: 'P1',
          variantId: 'V-A',
          categoryId: 'CAT1',
          brandId: null,
        },
      );
      expect(result).toBe('CATEGORY');
    });

    it('returns null when a CATEGORIES-typed target does NOT hit line.categoryId', () => {
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'CATEGORIES', targetId: 'CAT1' }],
        {
          productId: 'P1',
          variantId: 'V-A',
          categoryId: 'CAT-OTHER',
          brandId: null,
        },
      );
      expect(result).toBeNull();
    });

    it('returns null when line.categoryId is null (null guard) — CATEGORIES never matches', () => {
      // Scenario 5: a line whose product has a null categoryId MUST
      // NOT match any CATEGORIES promotion. Mirrors the variantId
      // != null guard at use-case.ts:84.
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'CATEGORIES', targetId: 'CAT1' }],
        { productId: 'P1', variantId: 'V-A', categoryId: null, brandId: null },
      );
      expect(result).toBeNull();
    });

    it('returns null when line.categoryId is omitted (legacy callers) — CATEGORIES never matches', () => {
      // Back-compat: callers that pre-date the widening (no
      // categoryId/brandId field on the line) MUST NOT silently
      // match a CATEGORIES target. The `!= null` guard fails on
      // undefined too.
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'CATEGORIES', targetId: 'CAT1' }],
        { productId: 'P1', variantId: 'V-A' },
      );
      expect(result).toBeNull();
    });
  });

  describe('BRANDS targeting (scenario 3)', () => {
    it('returns "BRAND" when a BRANDS-typed target hits line.brandId', () => {
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' }],
        { productId: 'P1', variantId: null, categoryId: null, brandId: 'BR1' },
      );
      expect(result).toBe('BRAND');
    });

    it('returns null when a BRANDS-typed target does NOT hit line.brandId', () => {
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' }],
        {
          productId: 'P1',
          variantId: null,
          categoryId: null,
          brandId: 'BR-OTHER',
        },
      );
      expect(result).toBeNull();
    });

    it('returns null when line.brandId is null (null guard) — BRANDS never matches', () => {
      // Scenario 6: a line whose product has a null brandId MUST NOT
      // match any BRANDS promotion.
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' }],
        { productId: 'P1', variantId: null, categoryId: null, brandId: null },
      );
      expect(result).toBeNull();
    });

    it('returns null when line.brandId is omitted (legacy callers) — BRANDS never matches', () => {
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'BRANDS', targetId: 'BR1' }],
        { productId: 'P1', variantId: null },
      );
      expect(result).toBeNull();
    });
  });

  describe('Specificity rule — VARIANT > {CATEGORY, BRAND}', () => {
    it('returns "VARIANT" when VARIANTS V-A target AND CATEGORIES CAT1 target both hit a V-A line whose categoryId=CAT1', () => {
      // Combined promo: VARIANTS V-A + CATEGORIES CAT1, applied to a
      // V-A line whose product's categoryId is CAT1. VARIANTS is
      // more specific → wins.
      const items: MiniTargetItem[] = [
        { side: 'DEFAULT', targetType: 'VARIANTS', targetId: 'V-A' },
        { side: 'DEFAULT', targetType: 'CATEGORIES', targetId: 'CAT1' },
      ];
      const result = matchTargetTier(items, {
        productId: 'P1',
        variantId: 'V-A',
        categoryId: 'CAT1',
        brandId: null,
      });
      expect(result).toBe('VARIANT');
    });

    it('returns "CATEGORY" when a CATEGORIES-typed target hits a V-A line whose categoryId=CAT1 (no VARIANTS target)', () => {
      // VARIANTS branch doesn't fire (no VARIANTS target); fall
      // through to CATEGORIES — confirms the branch order.
      const result = matchTargetTier(
        [{ side: 'DEFAULT', targetType: 'CATEGORIES', targetId: 'CAT1' }],
        {
          productId: 'P1',
          variantId: 'V-A',
          categoryId: 'CAT1',
          brandId: null,
        },
      );
      expect(result).toBe('CATEGORY');
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

  describe('side discriminator (WU1 — ADVANCED side-aware matcher)', () => {
    it('BUY-side items match a PRODUCTS-typed target when side=BUY (ADVANCED buy side)', () => {
      // The engine calls `matchTargetTier(items, line, 'BUY')` when
      // counting BUY-side matches for ADVANCED. A BUY-side PRODUCTS
      // target on P1 must hit a P1 line.
      const items: MiniTargetItem[] = [
        { side: 'BUY', targetType: 'PRODUCTS', targetId: 'P1' },
        { side: 'GET', targetType: 'PRODUCTS', targetId: 'P2' },
      ];
      const result = matchTargetTier(
        items,
        {
          productId: 'P1',
          variantId: null,
        },
        'BUY',
      );
      expect(result).toBe('PRODUCT');
    });

    it('GET-side items match a PRODUCTS-typed target when side=GET (ADVANCED get side)', () => {
      // The engine calls `matchTargetTier(items, line, 'GET')` when
      // evaluating which GET-side lines carry the reward. A GET-side
      // PRODUCTS target on P2 must hit a P2 line.
      const items: MiniTargetItem[] = [
        { side: 'BUY', targetType: 'PRODUCTS', targetId: 'P1' },
        { side: 'GET', targetType: 'PRODUCTS', targetId: 'P2' },
      ];
      const result = matchTargetTier(
        items,
        {
          productId: 'P2',
          variantId: null,
        },
        'GET',
      );
      expect(result).toBe('PRODUCT');
    });

    it("returns null when side='BUY' but only GET-side targets are present", () => {
      // Side filter is exclusive: a BUY query must NOT match GET-side
      // targets.
      const items: MiniTargetItem[] = [
        { side: 'GET', targetType: 'PRODUCTS', targetId: 'P1' },
      ];
      const result = matchTargetTier(
        items,
        {
          productId: 'P1',
          variantId: null,
        },
        'BUY',
      );
      expect(result).toBeNull();
    });

    it("returns null when side='GET' but only BUY-side targets are present", () => {
      const items: MiniTargetItem[] = [
        { side: 'BUY', targetType: 'PRODUCTS', targetId: 'P1' },
      ];
      const result = matchTargetTier(
        items,
        {
          productId: 'P1',
          variantId: null,
        },
        'GET',
      );
      expect(result).toBeNull();
    });

    it("side='DEFAULT' (default) returns null when only BUY/GET-side targets are present — preserves PD/BXGY contract", () => {
      // The DEFAULT side contract MUST be preserved byte-for-byte for
      // existing PRODUCT_DISCOUNT and BUY_X_GET_Y call sites — those
      // pass `side='DEFAULT'` (or no arg) and a BUY/GET-only target
      // list MUST still return null (BUY/GET never belonged to the
      // DEFAULT-side matcher).
      const items: MiniTargetItem[] = [
        { side: 'BUY', targetType: 'PRODUCTS', targetId: 'P1' },
        { side: 'GET', targetType: 'PRODUCTS', targetId: 'P1' },
      ];
      const result = matchTargetTier(
        items,
        {
          productId: 'P1',
          variantId: null,
        },
        'DEFAULT',
      );
      expect(result).toBeNull();
    });

    it('side-aware VARIANTS tier: BUY-side VARIANTS target hits a V-A line when side=BUY', () => {
      const items: MiniTargetItem[] = [
        { side: 'BUY', targetType: 'VARIANTS', targetId: 'V-A' },
        { side: 'GET', targetType: 'VARIANTS', targetId: 'V-B' },
      ];
      const result = matchTargetTier(
        items,
        {
          productId: 'P1',
          variantId: 'V-A',
        },
        'BUY',
      );
      expect(result).toBe('VARIANT');
    });

    it('side-aware CATEGORIES tier: GET-side CATEGORIES target hits the line.categoryId when side=GET', () => {
      const items: MiniTargetItem[] = [
        { side: 'BUY', targetType: 'CATEGORIES', targetId: 'CAT-BUY' },
        { side: 'GET', targetType: 'CATEGORIES', targetId: 'CAT-GET' },
      ];
      const result = matchTargetTier(
        items,
        {
          productId: 'P1',
          variantId: null,
          categoryId: 'CAT-GET',
          brandId: null,
        },
        'GET',
      );
      expect(result).toBe('CATEGORY');
    });

    it('side-aware BRANDS tier: BUY-side BRANDS target hits the line.brandId when side=BUY', () => {
      const items: MiniTargetItem[] = [
        { side: 'BUY', targetType: 'BRANDS', targetId: 'BR-BUY' },
        { side: 'GET', targetType: 'BRANDS', targetId: 'BR-GET' },
      ];
      const result = matchTargetTier(
        items,
        {
          productId: 'P1',
          variantId: null,
          categoryId: null,
          brandId: 'BR-BUY',
        },
        'BUY',
      );
      expect(result).toBe('BRAND');
    });

    it('no side argument defaults to DEFAULT — legacy callers (PD/BXGY) get unchanged behavior', () => {
      // When no `side` argument is passed, the matcher MUST default to
      // 'DEFAULT' so the existing PRODUCT_DISCOUNT and BUY_X_GET_Y
      // callers — which already pass no side — keep compiling and
      // returning the same result as before.
      const items: MiniTargetItem[] = [
        { side: 'DEFAULT', targetType: 'PRODUCTS', targetId: 'P1' },
      ];
      // Note: no third argument.
      const result = matchTargetTier(items, {
        productId: 'P1',
        variantId: null,
      });
      expect(result).toBe('PRODUCT');
    });
  });

  describe('edge cases', () => {
    it('returns null when targetItems is empty', () => {
      const result = matchTargetTier(
        [] satisfies MiniTargetItem[],
        {
          productId: 'P1',
          variantId: 'V-A',
        } satisfies MiniLine,
      );
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
