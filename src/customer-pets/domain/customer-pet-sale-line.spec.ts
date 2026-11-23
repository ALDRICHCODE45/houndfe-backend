import { CustomerPetError } from './customer-pet-error';
import {
  resolveSaleLinePet,
  toSaleLinePetView,
  type SaleLinePetFacts,
} from './customer-pet-sale-line';

const pet = (over: Partial<SaleLinePetFacts> = {}): SaleLinePetFacts => ({
  id: 'pet-1',
  customerId: 'c-1',
  name: 'Bruno',
  species: 'DOG',
  status: 'ACTIVE',
  ...over,
});

function codeOf(fn: () => unknown): { code: string; status: number } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(CustomerPetError);
    const err = e as CustomerPetError;
    return { code: err.code, status: err.status };
  }
  throw new Error('expected a CustomerPetError');
}

describe('resolveSaleLinePet (contract §4.2)', () => {
  it('returns the snapshot of an ACTIVE pet of the sale customer', () => {
    expect(resolveSaleLinePet('pet-1', 'c-1', pet())).toEqual({
      petId: 'pet-1',
      petNameSnapshot: 'Bruno',
      petSpeciesSnapshot: 'DOG',
    });
  });

  it('unknown pet → 404 PET_NOT_FOUND', () => {
    expect(codeOf(() => resolveSaleLinePet('pet-1', 'c-1', null))).toEqual({
      code: 'PET_NOT_FOUND',
      status: 404,
    });
  });

  it('pet of another customer → 422 PET_CUSTOMER_MISMATCH', () => {
    expect(
      codeOf(() =>
        resolveSaleLinePet('pet-1', 'c-1', pet({ customerId: 'c-2' })),
      ),
    ).toEqual({ code: 'PET_CUSTOMER_MISMATCH', status: 422 });
  });

  it('sale without customer → 422 PET_CUSTOMER_MISMATCH, even for an unknown pet', () => {
    expect(codeOf(() => resolveSaleLinePet('pet-1', null, pet()))).toEqual({
      code: 'PET_CUSTOMER_MISMATCH',
      status: 422,
    });
    expect(codeOf(() => resolveSaleLinePet('pet-1', null, null))).toEqual({
      code: 'PET_CUSTOMER_MISMATCH',
      status: 422,
    });
  });

  it('ARCHIVED pet of the customer → 422 PET_ARCHIVED', () => {
    expect(
      codeOf(() =>
        resolveSaleLinePet('pet-1', 'c-1', pet({ status: 'ARCHIVED' })),
      ),
    ).toEqual({ code: 'PET_ARCHIVED', status: 422 });
  });

  it('an archived pet of ANOTHER customer is a mismatch, not archived (no leak)', () => {
    expect(
      codeOf(() =>
        resolveSaleLinePet(
          'pet-1',
          'c-1',
          pet({ customerId: 'c-2', status: 'ARCHIVED' }),
        ),
      ).code,
    ).toBe('PET_CUSTOMER_MISMATCH');
  });
});

describe('toSaleLinePetView (contract §4.1)', () => {
  it('id/name/species come from the line, status is the current one', () => {
    expect(
      toSaleLinePetView({
        petId: 'pet-1',
        petNameSnapshot: 'Bruno',
        petSpeciesSnapshot: 'DOG',
        petStatus: 'ARCHIVED',
      }),
    ).toEqual({
      id: 'pet-1',
      name: 'Bruno',
      species: 'DOG',
      status: 'ARCHIVED',
    });
  });

  it('pet row gone but snapshot kept (customer deleted) → status null', () => {
    expect(
      toSaleLinePetView({
        petId: null,
        petNameSnapshot: 'Bruno',
        petSpeciesSnapshot: 'DOG',
        petStatus: null,
      }),
    ).toEqual({ id: null, name: 'Bruno', species: 'DOG', status: null });
  });

  it.each([
    [{ petId: null, petNameSnapshot: null, petSpeciesSnapshot: null }],
    [{}],
    // erased pet: only the status could linger; never an object of nulls
    [
      {
        petId: null,
        petNameSnapshot: null,
        petSpeciesSnapshot: null,
        petStatus: 'ACTIVE' as const,
      },
    ],
  ])('no snapshot → null (%j)', (line) => {
    expect(toSaleLinePetView(line)).toBeNull();
  });
});
