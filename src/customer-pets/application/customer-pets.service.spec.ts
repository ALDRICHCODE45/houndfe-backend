/* eslint-disable @typescript-eslint/no-unsafe-member-access -- jest mock call tuples */
import type { ConfigService } from '@nestjs/config';
import {
  CustomerPetError,
  CustomerPetValidationError,
} from '../domain/customer-pet-error';
import type {
  ICustomerPetRepository,
  PetWriteOutcome,
} from '../domain/customer-pet.repository';
import type { PetRecord } from '../domain/customer-pet.types';
import { CustomerPetsService } from './customer-pets.service';

const NOW = new Date('2026-11-23T18:00:00.000Z'); // 12:00 in Mexico City
const CUSTOMER = 'c-1';

function record(over: Partial<PetRecord> = {}): PetRecord {
  return {
    id: 'pet-1',
    tenantId: 't-1',
    customerId: CUSTOMER,
    name: 'Bruno',
    nameKey: 'bruno',
    species: 'DOG',
    speciesOther: null,
    breed: null,
    size: null,
    birthDate: null,
    birthDatePrecision: null,
    allergies: null,
    notes: null,
    status: 'ACTIVE',
    archivedAt: null,
    archivedReason: null,
    createdVia: 'POS',
    version: 3,
    createdAt: new Date('2026-11-01T10:00:00.000Z'),
    updatedAt: new Date('2026-11-02T10:00:00.000Z'),
    ...over,
  };
}

function setup(timezone?: string) {
  const repo = {
    customerExists: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
    findById: jest.fn().mockResolvedValue(record()),
    create: jest.fn(),
    updateIfVersion: jest.fn(),
    deleteIfVersion: jest.fn(),
  } satisfies Record<keyof ICustomerPetRepository, jest.Mock>;
  const config = {
    get: jest.fn((key: string) =>
      key === 'PROMOTIONS_BUSINESS_TIMEZONE' ? timezone : undefined,
    ),
  };
  const service = new CustomerPetsService(
    repo as unknown as ICustomerPetRepository,
    config as unknown as ConfigService,
  );
  return { service, repo };
}

const ok = (pet: PetRecord, duplicateName = false): PetWriteOutcome => ({
  kind: 'ok',
  pet,
  duplicateName,
});

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(CustomerPetError);
    return e as CustomerPetError;
  }
  throw new Error('expected a CustomerPetError');
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
});
afterEach(() => jest.useRealTimers());

describe('CustomerPetsService.create', () => {
  it('stores the normalized data with createdVia and returns the complete pet + warnings', async () => {
    const { service, repo } = setup();
    repo.create.mockResolvedValue(
      ok(
        record({
          birthDate: '2026-01-01',
          birthDatePrecision: 'MONTH',
          createdVia: 'CHATBOT',
          version: 1,
        }),
      ),
    );

    const result = await service.create(
      CUSTOMER,
      { name: '  Bruno ', species: 'DOG', approxAge: { months: 10 } },
      'CHATBOT',
    );

    expect(repo.create).toHaveBeenCalledTimes(1);
    const [customerId, id, data, createdVia] = repo.create.mock.calls[0] as [
      string,
      string,
      Record<string, unknown>,
      string,
    ];
    expect(customerId).toBe(CUSTOMER);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data).toMatchObject({
      name: 'Bruno',
      nameKey: 'bruno',
      birthDate: '2026-01-01',
      birthDatePrecision: 'MONTH',
    });
    expect(createdVia).toBe('CHATBOT');
    expect(result).toMatchObject({
      id: 'pet-1',
      ageMonths: 10,
      ageLabel: '~10 meses',
      createdVia: 'CHATBOT',
      warnings: [],
    });
  });

  it('adds PET_NAME_DUPLICATE when the repository saw another active pet with the same key', async () => {
    const { service, repo } = setup();
    repo.create.mockResolvedValue(ok(record(), true));
    const result = await service.create(
      CUSTOMER,
      { name: 'Bruno', species: 'DOG' },
      'POS',
    );
    expect(result.warnings).toEqual(['PET_NAME_DUPLICATE']);
  });

  it('computes the age in the configured timezone (day boundary)', async () => {
    // 2026-11-24T03:00Z is still the 23rd in Mexico City (UTC-6) …
    jest.setSystemTime(new Date('2026-11-24T03:00:00.000Z'));
    const mx = setup('America/Mexico_City');
    mx.repo.create.mockResolvedValue(ok(record()));
    await mx.service.create(
      CUSTOMER,
      {
        name: 'Max',
        species: 'DOG',
        birthDate: '2026-11-23',
        birthDatePrecision: 'EXACT',
      },
      'POS',
    );
    expect(mx.repo.create).toHaveBeenCalled();

    // … but already the 24th in UTC, where the 24th is fine and the 25th is future.
    const utc = setup('UTC');
    await expect(
      utc.service.create(
        CUSTOMER,
        {
          name: 'Max',
          species: 'DOG',
          birthDate: '2026-11-25',
          birthDatePrecision: 'EXACT',
        },
        'POS',
      ),
    ).rejects.toBeInstanceOf(CustomerPetValidationError);
    expect(utc.repo.create).not.toHaveBeenCalled();

    // The 24th is in the future in Mexico City.
    await expect(
      mx.service.create(
        CUSTOMER,
        {
          name: 'Max',
          species: 'DOG',
          birthDate: '2026-11-24',
          birthDatePrecision: 'EXACT',
        },
        'POS',
      ),
    ).rejects.toBeInstanceOf(CustomerPetValidationError);
  });

  it('defaults the timezone to America/Mexico_City', async () => {
    jest.setSystemTime(new Date('2026-11-24T03:00:00.000Z'));
    const { service, repo } = setup(undefined);
    await expect(
      service.create(
        CUSTOMER,
        {
          name: 'Max',
          species: 'DOG',
          birthDate: '2026-11-24',
          birthDatePrecision: 'EXACT',
        },
        'POS',
      ),
    ).rejects.toBeInstanceOf(CustomerPetValidationError);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it.each([
    ['customer_not_found', 'CUSTOMER_NOT_FOUND'],
    ['limit_reached', 'PET_LIMIT_REACHED'],
  ] as const)('%s → %s', async (kind, code) => {
    const { service, repo } = setup();
    repo.create.mockResolvedValue({ kind });
    const error = await codeOf(
      service.create(CUSTOMER, { name: 'Max', species: 'DOG' }, 'POS'),
    );
    expect(error.code).toBe(code);
  });

  it('a validation error never reaches the repository', async () => {
    const { service, repo } = setup();
    await expect(
      service.create(CUSTOMER, { name: '', species: 'DOG' }, 'POS'),
    ).rejects.toBeInstanceOf(CustomerPetValidationError);
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('CustomerPetsService.update', () => {
  it('writes only the patched columns under the expected version', async () => {
    const { service, repo } = setup();
    repo.updateIfVersion.mockResolvedValue(
      ok(record({ breed: 'Poodle', version: 4 })),
    );

    const result = await service.update(CUSTOMER, 'pet-1', 3, {
      breed: 'Poodle',
    });

    expect(repo.updateIfVersion).toHaveBeenCalledWith(
      CUSTOMER,
      'pet-1',
      3,
      { breed: 'Poodle' },
      { enforceLimit: false, checkDuplicate: false },
    );
    expect(result).toMatchObject({ breed: 'Poodle', version: 4, warnings: [] });
  });

  it('asks for the duplicate check only when the name changes', async () => {
    const { service, repo } = setup();
    repo.updateIfVersion.mockResolvedValue(ok(record({ name: 'Max' }), true));

    const result = await service.update(CUSTOMER, 'pet-1', 3, { name: 'Max' });

    expect(repo.updateIfVersion.mock.calls[0][4]).toEqual({
      enforceLimit: false,
      checkDuplicate: true,
    });
    expect(result.warnings).toEqual(['PET_NAME_DUPLICATE']);

    repo.updateIfVersion.mockClear();
    repo.updateIfVersion.mockResolvedValue(ok(record()));
    await service.update(CUSTOMER, 'pet-1', 3, { name: 'Bruno' });
    expect(repo.updateIfVersion.mock.calls[0][4]).toEqual({
      enforceLimit: false,
      checkDuplicate: false,
    });
  });

  it('stale version → PET_VERSION_CONFLICT with currentVersion, nothing written', async () => {
    const { service, repo } = setup();
    const error = await codeOf(
      service.update(CUSTOMER, 'pet-1', 2, { breed: 'x' }),
    );
    expect(error.code).toBe('PET_VERSION_CONFLICT');
    expect(error.details).toEqual({ currentVersion: 3 });
    expect(repo.updateIfVersion).not.toHaveBeenCalled();
  });

  it('losing the race (stale at write time) rereads and answers the new currentVersion', async () => {
    const { service, repo } = setup();
    repo.findById
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(record({ version: 4 }));
    repo.updateIfVersion.mockResolvedValue({ kind: 'stale' });
    const error = await codeOf(
      service.update(CUSTOMER, 'pet-1', 3, { breed: 'x' }),
    );
    expect(error.code).toBe('PET_VERSION_CONFLICT');
    expect(error.details).toEqual({ currentVersion: 4 });
  });

  it('losing the race to a delete answers PET_NOT_FOUND', async () => {
    const { service, repo } = setup();
    repo.findById.mockResolvedValueOnce(record()).mockResolvedValueOnce(null);
    repo.updateIfVersion.mockResolvedValue({ kind: 'stale' });
    const error = await codeOf(
      service.update(CUSTOMER, 'pet-1', 3, { breed: 'x' }),
    );
    expect(error.code).toBe('PET_NOT_FOUND');
  });

  it('PATCH on an ARCHIVED pet → PET_ARCHIVED, nothing written', async () => {
    const { service, repo } = setup();
    repo.findById.mockResolvedValue(record({ status: 'ARCHIVED' }));
    const error = await codeOf(
      service.update(CUSTOMER, 'pet-1', 3, { breed: 'x' }),
    );
    expect(error.code).toBe('PET_ARCHIVED');
    expect(repo.updateIfVersion).not.toHaveBeenCalled();
  });

  it('unknown pet → PET_NOT_FOUND; unknown customer → CUSTOMER_NOT_FOUND', async () => {
    const { service, repo } = setup();
    repo.findById.mockResolvedValue(null);
    expect((await codeOf(service.update(CUSTOMER, 'x', 1, {}))).code).toBe(
      'PET_NOT_FOUND',
    );
    repo.customerExists.mockResolvedValue(false);
    expect((await codeOf(service.update(CUSTOMER, 'x', 1, {}))).code).toBe(
      'CUSTOMER_NOT_FOUND',
    );
    expect(repo.updateIfVersion).not.toHaveBeenCalled();
  });

  it('a validation error (null name) never reaches the repository', async () => {
    const { service, repo } = setup();
    await expect(
      service.update(CUSTOMER, 'pet-1', 3, { name: null }),
    ).rejects.toBeInstanceOf(CustomerPetValidationError);
    expect(repo.updateIfVersion).not.toHaveBeenCalled();
  });
});

describe('CustomerPetsService.archive / restore', () => {
  it('archive sets ARCHIVED with archivedAt and the trimmed reason', async () => {
    const { service, repo } = setup();
    repo.updateIfVersion.mockResolvedValue(
      ok(record({ status: 'ARCHIVED', archivedAt: NOW, version: 4 })),
    );
    const result = await service.archive(CUSTOMER, 'pet-1', 3, ' Ya no está ');
    expect(repo.updateIfVersion).toHaveBeenCalledWith(
      CUSTOMER,
      'pet-1',
      3,
      { status: 'ARCHIVED', archivedAt: NOW, archivedReason: 'Ya no está' },
      { enforceLimit: false, checkDuplicate: false },
    );
    expect(result).toMatchObject({ status: 'ARCHIVED', warnings: [] });
  });

  it('archive without a reason stores null; a reason over 280 is a 400', async () => {
    const { service, repo } = setup();
    repo.updateIfVersion.mockResolvedValue(ok(record()));
    await service.archive(CUSTOMER, 'pet-1', 3);
    expect(repo.updateIfVersion.mock.calls[0][3]).toMatchObject({
      archivedReason: null,
    });
    repo.updateIfVersion.mockClear();
    await expect(
      service.archive(CUSTOMER, 'pet-1', 3, 'x'.repeat(281)),
    ).rejects.toBeInstanceOf(CustomerPetValidationError);
    expect(repo.updateIfVersion).not.toHaveBeenCalled();
  });

  it('archiving an archived pet → PET_ARCHIVED', async () => {
    const { service, repo } = setup();
    repo.findById.mockResolvedValue(record({ status: 'ARCHIVED' }));
    expect((await codeOf(service.archive(CUSTOMER, 'pet-1', 3))).code).toBe(
      'PET_ARCHIVED',
    );
    expect(repo.updateIfVersion).not.toHaveBeenCalled();
  });

  it('restore reactivates, enforces the limit and checks duplicates', async () => {
    const { service, repo } = setup();
    repo.findById.mockResolvedValue(record({ status: 'ARCHIVED' }));
    repo.updateIfVersion.mockResolvedValue(ok(record({ version: 4 }), true));
    const result = await service.restore(CUSTOMER, 'pet-1', 3);
    expect(repo.updateIfVersion).toHaveBeenCalledWith(
      CUSTOMER,
      'pet-1',
      3,
      { status: 'ACTIVE', archivedAt: null, archivedReason: null },
      { enforceLimit: true, checkDuplicate: true },
    );
    expect(result.warnings).toEqual(['PET_NAME_DUPLICATE']);
  });

  it('restoring an active pet → PET_NOT_ARCHIVED; the limit → PET_LIMIT_REACHED', async () => {
    const { service, repo } = setup();
    expect((await codeOf(service.restore(CUSTOMER, 'pet-1', 3))).code).toBe(
      'PET_NOT_ARCHIVED',
    );
    expect(repo.updateIfVersion).not.toHaveBeenCalled();

    repo.findById.mockResolvedValue(record({ status: 'ARCHIVED' }));
    repo.updateIfVersion.mockResolvedValue({ kind: 'limit_reached' });
    expect((await codeOf(service.restore(CUSTOMER, 'pet-1', 3))).code).toBe(
      'PET_LIMIT_REACHED',
    );
  });

  it('a stale version wins over the state error', async () => {
    const { service } = setup();
    const error = await codeOf(service.restore(CUSTOMER, 'pet-1', 1));
    expect(error.code).toBe('PET_VERSION_CONFLICT');
    expect(error.details).toEqual({ currentVersion: 3 });
  });
});

describe('CustomerPetsService.delete', () => {
  it('deletes under the expected version', async () => {
    const { service, repo } = setup();
    repo.deleteIfVersion.mockResolvedValue({ kind: 'deleted' });
    await expect(service.delete(CUSTOMER, 'pet-1', 3)).resolves.toBeUndefined();
    expect(repo.deleteIfVersion).toHaveBeenCalledWith(CUSTOMER, 'pet-1', 3);
  });

  it('stale → PET_VERSION_CONFLICT with currentVersion', async () => {
    const { service, repo } = setup();
    repo.deleteIfVersion.mockResolvedValue({
      kind: 'version_conflict',
      currentVersion: 5,
    });
    const error = await codeOf(service.delete(CUSTOMER, 'pet-1', 3));
    expect(error.code).toBe('PET_VERSION_CONFLICT');
    expect(error.details).toEqual({ currentVersion: 5 });
  });

  it('already deleted → PET_NOT_FOUND; unknown customer → CUSTOMER_NOT_FOUND', async () => {
    const { service, repo } = setup();
    repo.deleteIfVersion.mockResolvedValue({ kind: 'not_found' });
    expect((await codeOf(service.delete(CUSTOMER, 'pet-1', 3))).code).toBe(
      'PET_NOT_FOUND',
    );
    repo.customerExists.mockResolvedValue(false);
    expect((await codeOf(service.delete(CUSTOMER, 'pet-1', 3))).code).toBe(
      'CUSTOMER_NOT_FOUND',
    );
  });
});

describe('CustomerPetsService.list', () => {
  it('lists with the status (default ACTIVE) and derives the age of each pet', async () => {
    const { service, repo } = setup();
    repo.list.mockResolvedValue([
      record({ birthDate: '2026-01-01', birthDatePrecision: 'MONTH' }),
    ]);
    const pets = await service.list(CUSTOMER);
    expect(repo.list).toHaveBeenCalledWith(CUSTOMER, 'ACTIVE');
    expect(pets).toHaveLength(1);
    expect(pets[0]).toMatchObject({ ageMonths: 10, ageLabel: '~10 meses' });
    await service.list(CUSTOMER, 'ALL');
    expect(repo.list).toHaveBeenLastCalledWith(CUSTOMER, 'ALL');
  });

  it('unknown customer → CUSTOMER_NOT_FOUND', async () => {
    const { service, repo } = setup();
    repo.customerExists.mockResolvedValue(false);
    expect((await codeOf(service.list(CUSTOMER))).code).toBe(
      'CUSTOMER_NOT_FOUND',
    );
    expect(repo.list).not.toHaveBeenCalled();
  });
});
