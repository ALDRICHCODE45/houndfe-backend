/**
 * shipping-zones / T2 (S4) — packaging routes reuse the product permissions.
 */
import { ProductPackagingController } from './product-packaging.controller';

describe('ProductPackagingController — permission metadata', () => {
  const table: Array<[keyof ProductPackagingController, string[][]]> = [
    ['getProduct', [['read', 'Product']]],
    ['putProduct', [['update', 'Product']]],
    ['deleteProduct', [['update', 'Product']]],
    ['getVariant', [['read', 'Product']]],
    ['putVariant', [['update', 'Product']]],
    ['deleteVariant', [['update', 'Product']]],
  ];

  it.each(table)('%s requires exactly %j', (method, expected) => {
    const handler = ProductPackagingController.prototype[method];
    expect(Reflect.getMetadata('required_permissions', handler)).toEqual(
      expected,
    );
  });
});
