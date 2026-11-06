/**
 * shipping-zones / T2 (S5) — "Un paquete por pedido" packing rule.
 */
import {
  buildOrderPackage,
  NoShippingBoxFitsError,
  PackagingDataMissingError,
  type PackageItem,
  type StandardBox,
} from './order-package';

const box = (
  overrides: Partial<StandardBox> & { id: string },
): StandardBox => ({
  name: overrides.id,
  innerLengthCm: 30,
  innerWidthCm: 20,
  innerHeightCm: 10,
  weightG: 200,
  maxContentWeightG: 5000,
  ...overrides,
});

const item = (overrides: Partial<PackageItem> = {}): PackageItem => ({
  productId: 'p1',
  variantId: null,
  quantity: 1,
  packageWeightG: 500,
  dims: { lengthCm: 10, widthCm: 10, heightCm: 5 },
  ...overrides,
});

const failure = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('expected buildOrderPackage to throw');
};

describe('buildOrderPackage', () => {
  it('adds Σ weight × quantity plus the chosen box weight', () => {
    const result = buildOrderPackage(
      [
        item({ packageWeightG: 300, quantity: 2 }),
        item({ productId: 'p2', packageWeightG: 150 }),
      ],
      [box({ id: 'b1', weightG: 120 })],
    );

    expect(result).toEqual({
      box: expect.objectContaining({ id: 'b1' }) as unknown,
      contentWeightG: 750,
      totalWeightG: 870,
      dims: { lengthCm: 30, widthCm: 20, heightCm: 10 },
    });
  });

  it('picks the smallest box by inner volume, whatever the input order', () => {
    const result = buildOrderPackage(
      [item()],
      [
        box({
          id: 'big',
          innerLengthCm: 60,
          innerWidthCm: 40,
          innerHeightCm: 40,
        }),
        box({
          id: 'small',
          innerLengthCm: 12,
          innerWidthCm: 12,
          innerHeightCm: 6,
        }),
        box({
          id: 'mid',
          innerLengthCm: 30,
          innerWidthCm: 20,
          innerHeightCm: 10,
        }),
      ],
    );

    expect(result.box.id).toBe('small');
  });

  it('breaks volume ties by the lighter own weight', () => {
    const result = buildOrderPackage(
      [item()],
      [box({ id: 'heavy', weightG: 400 }), box({ id: 'light', weightG: 90 })],
    );

    expect(result.box.id).toBe('light');
    expect(result.totalWeightG).toBe(590);
  });

  it('compares sorted dimensions, so a rotated item still fits', () => {
    // Item 5 × 25 × 18 sorted is 25/18/5; the box 10 × 30 × 20 sorted is 30/20/10.
    const result = buildOrderPackage(
      [item({ dims: { lengthCm: 5, widthCm: 25, heightCm: 18 } })],
      [
        box({
          id: 'b',
          innerLengthCm: 10,
          innerWidthCm: 30,
          innerHeightCm: 20,
        }),
      ],
    );

    expect(result.box.id).toBe('b');
  });

  it('skips a box whose sorted dimensions are too small for one item', () => {
    const result = buildOrderPackage(
      [item({ dims: { lengthCm: 31, widthCm: 2, heightCm: 2 } })],
      [
        box({
          id: 'short',
          innerLengthCm: 30,
          innerWidthCm: 30,
          innerHeightCm: 30,
        }),
        box({
          id: 'long',
          innerLengthCm: 40,
          innerWidthCm: 10,
          innerHeightCm: 10,
        }),
      ],
    );

    expect(result.box.id).toBe('long');
  });

  it('accepts dimensions equal to the inner dimensions, decimals included', () => {
    const result = buildOrderPackage(
      [item({ dims: { lengthCm: 10.5, widthCm: 7.2, heightCm: 3.1 } })],
      [
        box({
          id: 'exact',
          innerLengthCm: 10.5,
          innerWidthCm: 7.2,
          innerHeightCm: 3.1,
        }),
      ],
    );

    expect(result.box.id).toBe('exact');
  });

  it('skips a box whose max content weight cannot hold the content', () => {
    const result = buildOrderPackage(
      [item({ packageWeightG: 1000, quantity: 3 })],
      [
        box({ id: 'weak', maxContentWeightG: 2999 }),
        box({ id: 'strong', innerLengthCm: 40, maxContentWeightG: 3000 }),
      ],
    );

    expect(result.box.id).toBe('strong');
  });

  it('skips a box whose inner volume is below the total item volume', () => {
    // 10 items of 10 × 10 × 5 (500 cm³ each) need 5000 cm³; 30 × 20 × 10 = 6000.
    const result = buildOrderPackage(
      [item({ quantity: 10, packageWeightG: 10 })],
      [
        box({
          id: 'tiny',
          innerLengthCm: 20,
          innerWidthCm: 20,
          innerHeightCm: 10,
        }),
        box({ id: 'ok' }),
      ],
    );

    expect(result.box.id).toBe('ok');
  });

  it('fails with PACKAGING_DATA_MISSING listing every product/variant without data', () => {
    const error = failure(() =>
      buildOrderPackage(
        [
          item({ productId: 'p1' }),
          item({ productId: 'p2', variantId: 'v2', packageWeightG: null }),
          item({ productId: 'p3', dims: null }),
          item({ productId: 'p2', variantId: 'v2', packageWeightG: null }),
        ],
        [box({ id: 'b1' })],
      ),
    );

    expect(error).toBeInstanceOf(PackagingDataMissingError);
    expect(error).toMatchObject({
      code: 'PACKAGING_DATA_MISSING',
      details: {
        missing: [
          { productId: 'p2', variantId: 'v2' },
          { productId: 'p3', variantId: null },
        ],
      },
    });
  });

  it('fails with NO_SHIPPING_BOX_FITS when no active box exists', () => {
    const error = failure(() => buildOrderPackage([item()], []));

    expect(error).toBeInstanceOf(NoShippingBoxFitsError);
    expect(error).toMatchObject({
      code: 'NO_SHIPPING_BOX_FITS',
      details: { contentWeightG: 500, boxesConsidered: 0 },
    });
  });

  it('fails with NO_SHIPPING_BOX_FITS when every box is too small or too weak', () => {
    const error = failure(() =>
      buildOrderPackage(
        [item({ dims: { lengthCm: 50, widthCm: 10, heightCm: 10 } })],
        [box({ id: 'b1' }), box({ id: 'b2', innerLengthCm: 45 })],
      ),
    );

    expect(error).toMatchObject({
      code: 'NO_SHIPPING_BOX_FITS',
      details: { contentWeightG: 500, boxesConsidered: 2 },
    });
  });

  it('rejects an empty order and a non-positive quantity', () => {
    expect(() => buildOrderPackage([], [box({ id: 'b1' })])).toThrow(
      'at least one item',
    );
    expect(() =>
      buildOrderPackage([item({ quantity: 0 })], [box({ id: 'b1' })]),
    ).toThrow('positive integer');
  });
});
