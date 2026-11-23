/**
 * customer-pets / T3 (S7) — the pet carried by a sale line (contract §4):
 * the line entity, its `pet` response member and the draft customer-change
 * rule. Existing stacking / response behavior is asserted to stay as before.
 */
import { Sale } from './sale.entity';
import { SaleItem, type SaleItemProps } from './sale-item.entity';

const props = (over: Partial<SaleItemProps> = {}): SaleItemProps => ({
  id: 'item-1',
  saleId: 'sale-1',
  productId: 'prod-1',
  variantId: null,
  productName: 'Croquetas',
  variantName: null,
  quantity: 2,
  unitPriceCents: 5000,
  unitPriceCurrency: 'MXN',
  ...over,
});

const BRUNO = {
  petId: 'pet-1',
  petNameSnapshot: 'Bruno',
  petSpeciesSnapshot: 'DOG' as const,
};

function draft(customerId: string | null = 'c-1'): Sale {
  const sale = Sale.create({ id: 'sale-1', userId: 'u-1' });
  if (customerId) sale.assignCustomer(customerId);
  return sale;
}

describe('SaleItem pet', () => {
  it('a line without pet answers `pet: null` (old lines, no pet)', () => {
    expect(SaleItem.create(props()).toResponse().pet).toBeNull();
    expect(SaleItem.fromPersistence(props()).toResponse().pet).toBeNull();
  });

  it('create copies the snapshot; status is the joined current one', () => {
    const item = SaleItem.fromPersistence(
      props({ ...BRUNO, petStatus: 'ARCHIVED' }),
    );
    expect(item.toResponse().pet).toEqual({
      id: 'pet-1',
      name: 'Bruno',
      species: 'DOG',
      status: 'ARCHIVED',
    });
    expect(item.petId).toBe('pet-1');
    expect(item.petNameSnapshot).toBe('Bruno');
    expect(item.petSpeciesSnapshot).toBe('DOG');
  });

  it('snapshot kept but pet row gone → status null; erased → pet null', () => {
    const gone = SaleItem.fromPersistence(
      props({ ...BRUNO, petId: null, petStatus: null }),
    );
    expect(gone.toResponse().pet).toEqual({
      id: null,
      name: 'Bruno',
      species: 'DOG',
      status: null,
    });
    const erased = SaleItem.fromPersistence(
      props({ petId: null, petNameSnapshot: null, petSpeciesSnapshot: null }),
    );
    expect(erased.toResponse().pet).toBeNull();
  });

  it('assignPet sets pet and snapshot (status ACTIVE); clearPet drops all three', () => {
    const item = SaleItem.create(props());
    item.assignPet(BRUNO);
    expect(item.toResponse().pet).toEqual({
      id: 'pet-1',
      name: 'Bruno',
      species: 'DOG',
      status: 'ACTIVE',
    });
    item.clearPet();
    expect(item.toResponse().pet).toBeNull();
    expect(item.petId).toBeNull();
    expect(item.petNameSnapshot).toBeNull();
    expect(item.petSpeciesSnapshot).toBeNull();
  });

  it('keeps every other response member (regression)', () => {
    const { pet, ...rest } = SaleItem.create(props()).toResponse();
    expect(pet).toBeNull();
    expect(rest).toMatchObject({
      id: 'item-1',
      productId: 'prod-1',
      quantity: 2,
      unitPriceCents: 5000,
      subtotalCents: 10000,
      promotionId: null,
    });
  });
});

describe('Sale draft: customer change clears line pets', () => {
  function withPetLine(customerId: string | null = 'c-1'): Sale {
    const sale = draft(customerId);
    sale.addItem(props({ ...BRUNO }));
    return sale;
  }

  it('a different customer clears every line pet and snapshot', () => {
    const sale = withPetLine();
    sale.addItem(props({ id: 'item-2', productId: 'prod-2', ...BRUNO }));
    sale.assignCustomer('c-2');
    for (const item of sale.items) {
      expect(item.toResponse().pet).toBeNull();
      expect(item.petId).toBeNull();
      expect(item.petNameSnapshot).toBeNull();
      expect(item.petSpeciesSnapshot).toBeNull();
    }
  });

  it('removing the customer clears them too', () => {
    const sale = withPetLine();
    sale.clearCustomer();
    expect(sale.items[0].toResponse().pet).toBeNull();
  });

  it('assigning the SAME customer again keeps the pets', () => {
    const sale = withPetLine();
    sale.assignCustomer('c-1');
    expect(sale.items[0].toResponse().pet).toMatchObject({ name: 'Bruno' });
  });

  it('hasLinePets / clearLinePets report whether something was cleared', () => {
    const sale = withPetLine();
    expect(sale.hasLinePets()).toBe(true);
    expect(sale.clearLinePets()).toBe(true);
    expect(sale.hasLinePets()).toBe(false);
    expect(sale.clearLinePets()).toBe(false);
  });

  it('a snapshot orphaned by a deleted customer also counts and is cleared', () => {
    const sale = draft(null);
    sale.addItem(props({ ...BRUNO, petId: null }));
    expect(sale.hasLinePets()).toBe(true);
    sale.assignCustomer('c-9');
    expect(sale.items[0].toResponse().pet).toBeNull();
  });
});

describe('Sale.addItem stacking is unchanged (regression)', () => {
  it('same product+variant stacks quantities and keeps the first line pet', () => {
    const sale = draft();
    sale.addItem(props({ ...BRUNO }));
    sale.addItem(props({ id: 'item-2', quantity: 3, ...BRUNO }));
    expect(sale.items).toHaveLength(1);
    expect(sale.items[0].quantity).toBe(5);
    expect(sale.items[0].petId).toBe('pet-1');
  });

  it('draft responses carry `pet: null` on lines without pet', () => {
    const sale = draft();
    sale.addItem(props());
    expect(sale.toResponse().items[0].pet).toBeNull();
  });
});
