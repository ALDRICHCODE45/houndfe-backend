import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('listing README conventions', () => {
  it('documents required listing conventions', () => {
    const content = readFileSync(join(__dirname, 'README.md'), 'utf8');

    expect(content).toContain('LISTING_TOO_MANY_VALUES');
    expect(content).toContain('LISTING_INVERTED_RANGE');
    expect(content).toContain('customerIncludeNull');
    expect(content).toContain('paymentMethodIncludeNull');
    expect(content).toContain('dueDateIncludeNull');
    expect(content).toContain('Add a new listing endpoint');
  });
});
