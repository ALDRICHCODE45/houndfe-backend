import { computePetCreateHash } from './customer-pet-bot-create.service';

describe('computePetCreateHash', () => {
  const customerId = '11111111-1111-4111-8111-111111111111';
  const base = { name: 'Bruno', species: 'DOG' as const };

  it('is stable and 64 hex chars', () => {
    const hash = computePetCreateHash(customerId, base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePetCreateHash(customerId, { ...base })).toBe(hash);
  });

  it('hashes null and absent members the same (a retry may spell absence differently)', () => {
    expect(
      computePetCreateHash(customerId, {
        ...base,
        breed: null,
        size: null,
        approxAge: null,
        notes: null,
      }),
    ).toBe(computePetCreateHash(customerId, base));
    expect(
      computePetCreateHash(customerId, {
        ...base,
        approxAge: { months: 10, years: undefined },
      }),
    ).toBe(
      computePetCreateHash(customerId, {
        ...base,
        approxAge: { months: 10, years: null as unknown as undefined },
      }),
    );
  });

  it.each([
    ['name', { ...base, name: 'Max' }],
    ['species', { ...base, species: 'CAT' as const }],
    ['breed', { ...base, breed: 'Chihuahua' }],
    ['size', { ...base, size: 'SMALL' as const }],
    ['birthDate', { ...base, birthDate: '2024-03-15' }],
    ['approxAge', { ...base, approxAge: { years: 3 } }],
    ['allergies', { ...base, allergies: 'Pollo' }],
    ['notes', { ...base, notes: 'Nervioso' }],
  ])('changes when %s changes', (_field, changed) => {
    expect(computePetCreateHash(customerId, changed)).not.toBe(
      computePetCreateHash(customerId, base),
    );
  });

  it('changes with the customer: the same key for another customer is a conflict', () => {
    expect(
      computePetCreateHash('22222222-2222-4222-8222-222222222222', base),
    ).not.toBe(computePetCreateHash(customerId, base));
  });
});
