import { Promotion } from '../domain/promotion.entity';
import type { IPromotionRepository } from '../domain/promotion.repository';
import { EvaluateCartPromotionsUseCase } from './evaluate-cart-promotions.use-case';
import type { CartItemForEvaluation } from './ports/evaluate-cart-promotions.port';

function makePromotion(
  overrides: Partial<Parameters<typeof Promotion.fromPersistence>[0]> = {},
): Promotion {
  return Promotion.fromPersistence({
    id: 'promo-1',
    title: 'Automatic promo',
    type: 'PRODUCT_DISCOUNT',
    method: 'AUTOMATIC',
    status: 'ACTIVE',
    startDate: null,
    endDate: null,
    customerScope: 'ALL',
    discountType: 'PERCENTAGE',
    discountValue: 10,
    minPurchaseAmountCents: null,
    appliesTo: 'PRODUCTS',
    buyQuantity: null,
    getQuantity: null,
    getDiscountPercent: null,
    buyTargetType: null,
    getTargetType: null,
    createdAt: new Date('2026-06-11T00:00:00.000Z'),
    updatedAt: new Date('2026-06-11T00:00:00.000Z'),
    targetItems: [
      {
        id: 'target-1',
        side: 'DEFAULT',
        targetType: 'PRODUCTS',
        targetId: 'prod-1',
      },
    ],
    customers: [],
    priceLists: [],
    daysOfWeek: [],
    ...overrides,
  });
}

function makeRepository(
  promotions: Promotion[],
): jest.Mocked<IPromotionRepository> {
  return {
    save: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn().mockResolvedValue({
      data: promotions,
      total: promotions.length,
    }),
    findActiveAutomaticSnapshot: jest
      .fn()
      .mockResolvedValue({ promotions, complete: true }),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    updateStatus: jest.fn(),
  } as jest.Mocked<IPromotionRepository>;
}

describe('EvaluateCartPromotionsUseCase', () => {
  it('applies an active percentage product discount to matching cart items', async () => {
    const repository = makeRepository([
      makePromotion({
        title: '10% off Royal Canin',
        discountType: 'PERCENTAGE',
        discountValue: 10,
      }),
    ]);
    const useCase = new EvaluateCartPromotionsUseCase(repository);

    await expect(
      useCase.execute({
        items: [
          {
            productId: 'prod-1',
            variantId: null,
            quantity: 2,
            unitPriceCents: 1000,
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          productId: 'prod-1',
          variantId: null,
          quantity: 2,
          unitPriceCents: 1000,
          originalPriceCents: 2000,
          finalPriceCents: 1800,
          appliedPromotionTitle: '10% off Royal Canin',
          discountAmountCents: 200,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('applies an active fixed product discount and caps it at the line total', async () => {
    const repository = makeRepository([
      makePromotion({
        title: '$3 off snack',
        discountType: 'FIXED',
        discountValue: 300,
      }),
    ]);
    const useCase = new EvaluateCartPromotionsUseCase(repository);

    await expect(
      useCase.execute({
        items: [
          {
            productId: 'prod-1',
            variantId: 'var-1',
            quantity: 2,
            unitPriceCents: 250,
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          productId: 'prod-1',
          variantId: 'var-1',
          quantity: 2,
          unitPriceCents: 250,
          originalPriceCents: 500,
          finalPriceCents: 0,
          appliedPromotionTitle: '$3 off snack',
          discountAmountCents: 500,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('returns needs_human_review when an unsupported active promotion is present', async () => {
    const repository = makeRepository([
      makePromotion({
        id: 'promo-advanced',
        title: 'Buy one get one mystery',
        type: 'BUY_X_GET_Y',
        discountType: null,
        discountValue: null,
        appliesTo: null,
        targetItems: [],
      }),
    ]);
    const useCase = new EvaluateCartPromotionsUseCase(repository);

    await expect(
      useCase.execute({
        items: [
          {
            productId: 'prod-1',
            variantId: null,
            quantity: 1,
            unitPriceCents: 1000,
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          productId: 'prod-1',
          variantId: null,
          quantity: 1,
          unitPriceCents: 1000,
          originalPriceCents: 1000,
          finalPriceCents: 1000,
          appliedPromotionTitle: null,
          discountAmountCents: 0,
        },
      ],
      promotionEvaluationStatus: 'needs_human_review',
    });
  });

  it('returns base pricing with fully_evaluated when there are no active automatic promotions', async () => {
    const repository = makeRepository([]);
    const useCase = new EvaluateCartPromotionsUseCase(repository);

    await expect(
      useCase.execute({
        items: [
          {
            productId: 'prod-1',
            variantId: null,
            quantity: 3,
            unitPriceCents: 1000,
          },
        ],
      }),
    ).resolves.toEqual({
      items: [
        {
          productId: 'prod-1',
          variantId: null,
          quantity: 3,
          unitPriceCents: 1000,
          originalPriceCents: 3000,
          finalPriceCents: 3000,
          appliedPromotionTitle: null,
          discountAmountCents: 0,
        },
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });
});

function productTarget(productId: string) {
  return {
    id: `target-${productId}`,
    side: 'DEFAULT' as const,
    targetType: 'PRODUCTS' as const,
    targetId: productId,
  };
}

function bothProductTargets() {
  return [productTarget('prod-1'), productTarget('prod-2')];
}

function cartLine(
  productId: string,
  quantity: number,
  unitPriceCents = 1000,
): CartItemForEvaluation {
  return { productId, variantId: null, quantity, unitPriceCents };
}

function expectedLine(
  productId: string,
  quantity: number,
  finalPriceCents: number,
  appliedPromotionTitle: string | null,
  unitPriceCents = 1000,
) {
  const originalPriceCents = unitPriceCents * quantity;
  return {
    productId,
    variantId: null,
    quantity,
    unitPriceCents,
    originalPriceCents,
    finalPriceCents,
    appliedPromotionTitle,
    discountAmountCents: originalPriceCents - finalPriceCents,
  };
}

function evaluate(promotions: Promotion[], items: CartItemForEvaluation[]) {
  return new EvaluateCartPromotionsUseCase(makeRepository(promotions)).execute({
    items,
  });
}

describe('EvaluateCartPromotionsUseCase capacity fallback', () => {
  it('excludes a capped promotion whose aggregate demand overruns and falls back on both lines without leaking the internal id', async () => {
    const result = await evaluate(
      [
        makePromotion({
          id: 'promo-capped',
          title: '10% off capped',
          maxProductUnits: 1,
          targetItems: bothProductTargets(),
        }),
        makePromotion({
          id: 'promo-fallback',
          title: '20% off fallback',
          discountValue: 20,
          targetItems: bothProductTargets(),
        }),
      ],
      [cartLine('prod-1', 1), cartLine('prod-2', 1)],
    );

    expect(result).toEqual({
      items: [
        expectedLine('prod-1', 1, 800, '20% off fallback'),
        expectedLine('prod-2', 1, 800, '20% off fallback'),
      ],
      promotionEvaluationStatus: 'fully_evaluated',
    });
    expect(Object.keys(result.items[0]).sort()).toEqual([
      'appliedPromotionTitle',
      'discountAmountCents',
      'finalPriceCents',
      'originalPriceCents',
      'productId',
      'quantity',
      'unitPriceCents',
      'variantId',
    ]);
  });

  const capacityCases = [
    {
      label:
        'returns base prices when a capped promotion overruns with no fallback',
      promotions: [
        makePromotion({
          id: 'promo-capped',
          maxProductUnits: 1,
          targetItems: bothProductTargets(),
        }),
      ],
      items: [cartLine('prod-1', 1), cartLine('prod-2', 1)],
      expectedItems: [
        expectedLine('prod-1', 1, 1000, null),
        expectedLine('prod-2', 1, 1000, null),
      ],
    },
    {
      label: 'applies a capped promotion when aggregate demand fits exactly',
      promotions: [
        makePromotion({
          id: 'promo-capped',
          maxProductUnits: 2,
          targetItems: bothProductTargets(),
        }),
      ],
      items: [cartLine('prod-1', 1), cartLine('prod-2', 1)],
      expectedItems: [
        expectedLine('prod-1', 1, 900, 'Automatic promo'),
        expectedLine('prod-2', 1, 900, 'Automatic promo'),
      ],
    },
    {
      label: 'applies an unlimited promotion regardless of aggregate demand',
      promotions: [
        makePromotion({
          id: 'promo-unlimited',
          maxProductUnits: null,
          targetItems: bothProductTargets(),
        }),
      ],
      items: [cartLine('prod-1', 5), cartLine('prod-2', 7)],
      expectedItems: [
        expectedLine('prod-1', 5, 4500, 'Automatic promo'),
        expectedLine('prod-2', 7, 6300, 'Automatic promo'),
      ],
    },
  ];

  it.each(capacityCases)(
    '$label',
    async ({ promotions, items, expectedItems }) => {
      await expect(evaluate(promotions, items)).resolves.toEqual({
        items: expectedItems,
        promotionEvaluationStatus: 'fully_evaluated',
      });
    },
  );

  it('excludes every overrun winner from the same pass and preserves needs_human_review for unsupported promotions', async () => {
    const promotions = [
      makePromotion({
        id: 'promo-a',
        maxProductUnits: 1,
        targetItems: [productTarget('prod-1')],
      }),
      makePromotion({
        id: 'promo-b',
        maxProductUnits: 1,
        targetItems: [productTarget('prod-2')],
      }),
      makePromotion({
        id: 'promo-fallback',
        title: '30% off fallback',
        discountValue: 30,
        targetItems: bothProductTargets(),
      }),
      makePromotion({
        id: 'promo-unsupported',
        type: 'BUY_X_GET_Y',
        discountType: null,
        discountValue: null,
        appliesTo: null,
        targetItems: [],
      }),
    ];

    await expect(
      evaluate(promotions, [cartLine('prod-1', 2), cartLine('prod-2', 2)]),
    ).resolves.toEqual({
      items: [
        expectedLine('prod-1', 2, 1400, '30% off fallback'),
        expectedLine('prod-2', 2, 1400, '30% off fallback'),
      ],
      promotionEvaluationStatus: 'needs_human_review',
    });
  });
});

// ============================================================
// Decided bot-preview behavior for incomplete restriction context.
//
// The public port is `execute({ items })` — see
// `ports/evaluate-cart-promotions.port.ts`. It carries NO customer,
// price-list, or weekday context, so a restricted promotion cannot be
// proven eligible here. Policy: fail the whole cart closed with base
// prices and `needs_human_review`, while an unrelated restricted
// promotion or a purely open promotion keeps normal behavior.
// ============================================================
describe('EvaluateCartPromotionsUseCase — restricted promotions without matching context', () => {
  const restrictedPromotions = [
    {
      label: 'customerScope=REGISTERED_ONLY with no customer context',
      promotion: makePromotion({
        id: 'promo-registered',
        title: 'Registered customers only',
        customerScope: 'REGISTERED_ONLY',
      }),
    },
    {
      label: 'customerScope=SPECIFIC with an unmatched customer list',
      promotion: makePromotion({
        id: 'promo-specific',
        title: 'Specific customers only',
        customerScope: 'SPECIFIC',
        customers: [{ id: 'pc-1', customerId: 'cust-1' }],
      }),
    },
    {
      label: 'foreign global price list with no price-list context',
      promotion: makePromotion({
        id: 'promo-price-list',
        title: 'GPL-retail only',
        priceLists: [{ id: 'ppl-1', globalPriceListId: 'GPL-retail' }],
      }),
    },
    {
      label: 'weekday-limited promotion with no day context',
      promotion: makePromotion({
        id: 'promo-sunday',
        title: 'Sundays only',
        daysOfWeek: [{ id: 'd-sun', day: 'SUNDAY' }],
      }),
    },
  ];

  it.each(restrictedPromotions)(
    'returns base prices with needs_human_review for $label',
    async ({ promotion }) => {
      // The bot preview cannot verify customer / price-list / weekday
      // eligibility, so the matching line is not discounted and the
      // whole cart is flagged for human review.
      await expect(
        evaluate([promotion], [cartLine('prod-1', 1)]),
      ).resolves.toEqual({
        items: [expectedLine('prod-1', 1, 1000, null)],
        promotionEvaluationStatus: 'needs_human_review',
      });
    },
  );

  it('returns base prices for EVERY line when a restricted promotion shares the cart with an open promotion', async () => {
    // The restricted promotion targets only prod-1, but the cart as a whole
    // is not provably evaluable, so even prod-2 — which the open promotion
    // would discount — stays at base price.
    const restricted = makePromotion({
      id: 'promo-restricted',
      title: 'Registered customers only',
      customerScope: 'REGISTERED_ONLY',
      targetItems: [productTarget('prod-1')],
    });
    const open = makePromotion({
      id: 'promo-open',
      title: 'Open promo',
      targetItems: bothProductTargets(),
    });

    await expect(
      evaluate(
        [restricted, open],
        [cartLine('prod-1', 1), cartLine('prod-2', 1)],
      ),
    ).resolves.toEqual({
      items: [
        expectedLine('prod-1', 1, 1000, null),
        expectedLine('prod-2', 1, 1000, null),
      ],
      promotionEvaluationStatus: 'needs_human_review',
    });
  });

  it('does not block an evaluable cart when the restricted promotion targets a different product', async () => {
    // The restriction is scoped to prod-2, which this cart does not contain,
    // so prod-1 remains fully evaluable and the open promotion applies.
    const restrictedElsewhere = makePromotion({
      id: 'promo-elsewhere',
      title: 'Sundays only elsewhere',
      daysOfWeek: [{ id: 'd-sun', day: 'SUNDAY' }],
      targetItems: [productTarget('prod-2')],
    });
    const open = makePromotion({
      id: 'promo-open',
      title: 'Open promo',
    });

    await expect(
      evaluate([restrictedElsewhere, open], [cartLine('prod-1', 1)]),
    ).resolves.toEqual({
      items: [expectedLine('prod-1', 1, 900, 'Open promo')],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('control: an unrestricted promotion on the same product still applies', async () => {
    // Same product, same cart shape, no restriction fields set — the
    // discount MUST land, proving the negatives above are caused by the
    // promotion restriction and not by the cart fixture.
    const result = await evaluate(
      [makePromotion({ id: 'promo-open', title: 'Open promo' })],
      [cartLine('prod-1', 1)],
    );

    expect(result).toEqual({
      items: [expectedLine('prod-1', 1, 900, 'Open promo')],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });
});

// ============================================================
// The quote path reads ONE bounded ACTIVE AUTOMATIC snapshot through the
// dedicated repository port (no offset paging and no separate count, so a
// concurrent delete+insert cannot shift an unread row past the window).
//
// A restriction sitting deep in the ordered set must still fail the cart
// closed; an unrelated one must not block a valid discount; and a snapshot
// the adapter reports as incomplete (tenant above the approved cap) must fail
// the WHOLE cart closed even when every visible promotion is open.
// ============================================================
describe('EvaluateCartPromotionsUseCase — bounded ACTIVE AUTOMATIC snapshot', () => {
  function openPromotions(count: number): Promotion[] {
    return Array.from({ length: count }, (_, index) =>
      makePromotion({
        id: `promo-open-${String(index).padStart(3, '0')}`,
        title: `Open promo ${index}`,
        targetItems: [productTarget('prod-1')],
      }),
    );
  }

  it('fails closed when a cart-relevant restriction sits deep in the ordered snapshot', async () => {
    const repository = makeRepository([
      ...openPromotions(100),
      makePromotion({
        id: 'promo-restricted-101',
        title: 'Registered customers only',
        customerScope: 'REGISTERED_ONLY',
        targetItems: [productTarget('prod-1')],
      }),
    ]);
    const useCase = new EvaluateCartPromotionsUseCase(repository);

    await expect(
      useCase.execute({ items: [cartLine('prod-1', 1)] }),
    ).resolves.toEqual({
      items: [expectedLine('prod-1', 1, 1000, null)],
      promotionEvaluationStatus: 'needs_human_review',
    });

    // Exactly one bounded snapshot read: no per-page queries and no
    // paginated fallback.
    expect(repository.findActiveAutomaticSnapshot.mock.calls.length).toBe(1);
    expect(repository.findAll.mock.calls.length).toBe(0);
  });

  it('still discounts when the only restriction targets an unrelated product', async () => {
    const repository = makeRepository([
      ...openPromotions(100),
      makePromotion({
        id: 'promo-restricted-101',
        title: 'Sundays only elsewhere',
        daysOfWeek: [{ id: 'd-sun', day: 'SUNDAY' }],
        targetItems: [productTarget('prod-2')],
      }),
    ]);

    await expect(
      evaluateWith(repository, [cartLine('prod-1', 1)]),
    ).resolves.toEqual({
      items: [expectedLine('prod-1', 1, 900, 'Open promo 0')],
      promotionEvaluationStatus: 'fully_evaluated',
    });
    expect(repository.findActiveAutomaticSnapshot.mock.calls.length).toBe(1);
  });

  it('discounts when the snapshot holds exactly the cap and is reported complete', async () => {
    // Boundary on the approved cap: 1000 visible rows is still a complete
    // snapshot, so the visible discount stands.
    const repository = makeRepository(openPromotions(1000));

    await expect(
      evaluateWith(repository, [cartLine('prod-1', 1)]),
    ).resolves.toEqual({
      items: [expectedLine('prod-1', 1, 900, 'Open promo 0')],
      promotionEvaluationStatus: 'fully_evaluated',
    });
  });

  it('fails the WHOLE cart closed when the snapshot is incomplete, even though every visible promotion is open', async () => {
    // The hidden overflow rows might be unrelated, but the adapter cannot
    // prove it — owner policy is all-or-nothing at the cap.
    const visible = openPromotions(1000);
    const repository = makeRepository(visible);
    repository.findActiveAutomaticSnapshot.mockResolvedValue({
      promotions: visible,
      complete: false,
    });

    await expect(
      evaluateWith(repository, [cartLine('prod-1', 1)]),
    ).resolves.toEqual({
      items: [expectedLine('prod-1', 1, 1000, null)],
      promotionEvaluationStatus: 'needs_human_review',
    });
  });

  it('fails closed without consulting the promotion set when the snapshot read fails outright', async () => {
    // A repository error must not become a silent base-price-only quote that
    // claims `fully_evaluated`.
    const repository = makeRepository([]);
    repository.findActiveAutomaticSnapshot.mockRejectedValue(
      new Error('snapshot unavailable'),
    );

    await expect(
      evaluateWith(repository, [cartLine('prod-1', 1)]),
    ).rejects.toThrow('snapshot unavailable');
  });
});

function evaluateWith(
  repository: jest.Mocked<IPromotionRepository>,
  items: CartItemForEvaluation[],
) {
  return new EvaluateCartPromotionsUseCase(repository).execute({ items });
}
