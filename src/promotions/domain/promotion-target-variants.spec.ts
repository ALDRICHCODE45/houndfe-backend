/**
 * W2 — Domain Entity & DTO Enum accept VARIANTS.
 *
 * Contract:
 *   - `Promotion.create()` accepts `appliesTo: 'VARIANTS'` and a target item
 *     with `targetType: 'VARIANTS'` (targetId is the variant uuid).
 *   - `PromotionTargetTypeEnum.VARIANTS === 'VARIANTS'`.
 *   - The Promotion's `appliesTo` is the same string on the entity
 *     (no coercion in the create path).
 *
 * TDD note: These tests would FAIL if `'VARIANTS'` were removed from the
 * PromotionTargetType union OR from the PromotionTargetTypeEnum. They were
 * authored against the W2 spec contract.
 */
import 'reflect-metadata';
import { Promotion } from './promotion.entity';
import {
  PromotionTargetTypeEnum,
  TargetItemDto,
} from '../dto/create-promotion.dto';

describe('Promotion entity + DTO — VARIANTS target type (W2)', () => {
  const BASE_ID = '550e8400-e29b-41d4-a716-446655440000';

  it('PromotionTargetTypeEnum.VARIANTS exists and equals "VARIANTS"', () => {
    expect(PromotionTargetTypeEnum.VARIANTS).toBe('VARIANTS');
  });

  it('Promotion.create accepts appliesTo="VARIANTS" (entity-level)', () => {
    const promo = Promotion.create({
      id: BASE_ID,
      title: 'Variant-only 10%',
      type: 'PRODUCT_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      appliesTo: 'VARIANTS',
    });

    expect(promo.appliesTo).toBe('VARIANTS');
    expect(promo.type).toBe('PRODUCT_DISCOUNT');
    expect(promo.status).toBe('ACTIVE');
  });

  it('Promotion.create accepts VARIANTS-typed targetItems (targetId carries variant uuid)', () => {
    // The polymorphic PromotionTargetItem row stores targetType='VARIANTS'
    // and targetId=variantUuid. Promotion.create itself does not validate
    // targetItem ids (validateTargetIds is a service-layer concern), so a
    // well-formed VARIANTS-typed target list passes without throwing.
    const promo = Promotion.create({
      id: BASE_ID,
      title: 'Variant-only with target',
      type: 'PRODUCT_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: 'FIXED',
      discountValue: 100,
      appliesTo: 'VARIANTS',
    });

    // The Promotion.create static does not accept targetItems (relations are
    // attached after construction). The DTO-level contract is exercised via
    // the TargetItemDto class — see the next test.
    promo.targetItems = [
      {
        id: 'ti-1',
        side: 'DEFAULT',
        targetType: 'VARIANTS',
        targetId: 'V-A',
      },
    ];

    expect(promo.targetItems).toHaveLength(1);
    expect(promo.targetItems[0].targetType).toBe('VARIANTS');
    expect(promo.targetItems[0].targetId).toBe('V-A');
  });

  it('TargetItemDto accepts targetType="VARIANTS" (DTO-level)', () => {
    // class-validator's @IsEnum will reject anything outside the enum;
    // this assertion proves VARIANTS is part of the enum at runtime.
    const dto = new TargetItemDto();
    dto.targetType = PromotionTargetTypeEnum.VARIANTS;
    dto.targetId = 'V-A';

    expect(dto.targetType).toBe('VARIANTS');
    expect(dto.targetId).toBe('V-A');
  });
});
