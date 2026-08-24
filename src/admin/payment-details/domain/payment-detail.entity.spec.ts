/**
 * Q1 / WU1 — Table-driven PaymentDetail entity spec.
 *
 * Covers:
 *   - CLABE validation: exactly 18 digits; non-digits rejected.
 *   - accountNumber validation: >= 10 digits.
 *   - bankName / beneficiary: trimmed, non-empty.
 *   - `deactivate()`: flips `isActive` and is idempotent (no extra
 *     `updatedAt` bump on already-inactive rows — preserves the
 *     "active = newest updatedAt" D2 selection rule).
 *   - `update()`: only mutates supplied fields, always bumps `updatedAt`.
 *   - `fromPersistence` round-trip: every field survives.
 *
 * Run via `pnpm test src/admin/payment-details/domain/payment-detail.entity.spec.ts`.
 */
import {
  PaymentDetail,
  sanitizeAccountNumber,
  sanitizeBankName,
  sanitizeBeneficiary,
  sanitizeClabe,
} from './payment-detail.entity';
import { InvalidArgumentError } from '../../../shared/domain/domain-error';

const BASE_INPUT = {
  id: 'pd-1',
  tenantId: 'tenant-1',
  bankName: 'BBVA',
  beneficiary: 'Tienda XYZ',
  clabe: '012345678901234567',
  accountNumber: '1234567890',
};

describe('PaymentDetail entity', () => {
  describe('create()', () => {
    it('builds an active entity with trimmed strings and ISO-serializable timestamps', () => {
      const entity = PaymentDetail.create({
        ...BASE_INPUT,
        bankName: '  BBVA  ',
        beneficiary: '  Tienda XYZ  ',
      });

      expect(entity.bankName).toBe('BBVA');
      expect(entity.beneficiary).toBe('Tienda XYZ');
      expect(entity.clabe).toBe('012345678901234567');
      expect(entity.accountNumber).toBe('1234567890');
      expect(entity.isActive).toBe(true);
      expect(entity.createdAt).toBeInstanceOf(Date);
      expect(entity.updatedAt).toBeInstanceOf(Date);
      expect(entity.createdAt.getTime()).toBe(entity.updatedAt.getTime());
    });

    it.each([
      ['id is empty', { ...BASE_INPUT, id: '' }, /id is required/],
      ['id is whitespace', { ...BASE_INPUT, id: '   ' }, /id is required/],
      [
        'tenantId is empty',
        { ...BASE_INPUT, tenantId: '' },
        /tenantId is required/,
      ],
    ])('throws when %s', (_label, input, pattern) => {
      expect(() => PaymentDetail.create(input)).toThrow(InvalidArgumentError);
      expect(() => PaymentDetail.create(input)).toThrow(pattern);
    });
  });

  describe('CLABE validation', () => {
    it.each([
      ['17 digits', '01234567890123456', /exactly 18 digits/],
      ['19 digits', '0123456789012345678', /exactly 18 digits/],
      ['with letters', '01234567890123456A', /exactly 18 digits/],
      ['with whitespace inside', '01234 678901234567', /exactly 18 digits/],
      ['with dashes', '0123-6789-0123-4567', /exactly 18 digits/],
    ])('rejects %s', (_label, value, pattern) => {
      expect(() => sanitizeClabe(value)).toThrow(InvalidArgumentError);
      expect(() => sanitizeClabe(value)).toThrow(pattern);
    });

    it('accepts exactly 18 digits and trims surrounding whitespace', () => {
      expect(sanitizeClabe('  012345678901234567  ')).toBe(
        '012345678901234567',
      );
    });
  });

  describe('accountNumber validation', () => {
    it.each([
      ['9 digits', '123456789', /at least 10 digits/],
      ['empty', '', /at least 10 digits/],
      ['contains letters', '12345abcde', /at least 10 digits/],
    ])('rejects %s', (_label, value, pattern) => {
      expect(() => sanitizeAccountNumber(value)).toThrow(InvalidArgumentError);
      expect(() => sanitizeAccountNumber(value)).toThrow(pattern);
    });

    it('accepts >=10 digits and trims', () => {
      expect(sanitizeAccountNumber('  1234567890  ')).toBe('1234567890');
      expect(sanitizeAccountNumber('123456789012345')).toBe('123456789012345');
    });
  });

  describe('bankName validation', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('rejects %s', (_label, value) => {
      expect(() => sanitizeBankName(value)).toThrow(InvalidArgumentError);
      expect(() => sanitizeBankName(value)).toThrow(/non-empty/);
    });

    it('trims surrounding whitespace', () => {
      expect(sanitizeBankName('  BBVA  ')).toBe('BBVA');
    });
  });

  describe('beneficiary validation', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
    ])('rejects %s', (_label, value) => {
      expect(() => sanitizeBeneficiary(value)).toThrow(InvalidArgumentError);
      expect(() => sanitizeBeneficiary(value)).toThrow(/non-empty/);
    });

    it('trims surrounding whitespace', () => {
      expect(sanitizeBeneficiary('  Tienda XYZ  ')).toBe('Tienda XYZ');
    });
  });

  describe('deactivate()', () => {
    it('flips isActive to false and bumps updatedAt', async () => {
      const entity = PaymentDetail.create(BASE_INPUT);
      const originalUpdatedAt = entity.updatedAt;
      // Force a measurable time gap so the bump is observable.
      await new Promise((r) => setTimeout(r, 5));
      entity.deactivate();

      expect(entity.isActive).toBe(false);
      expect(entity.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime(),
      );
    });

    it('is idempotent — does NOT bump updatedAt when already inactive', async () => {
      const entity = PaymentDetail.create(BASE_INPUT);
      entity.deactivate();
      const firstDeactivateAt = entity.updatedAt.getTime();
      await new Promise((r) => setTimeout(r, 5));
      entity.deactivate();
      // No bump on the second call — protects the "active = newest
      // updatedAt" D2 selection rule from false-fresh inactive rows.
      expect(entity.updatedAt.getTime()).toBe(firstDeactivateAt);
      expect(entity.isActive).toBe(false);
    });
  });

  describe('update()', () => {
    it('only mutates the supplied fields and always bumps updatedAt', async () => {
      const entity = PaymentDetail.create(BASE_INPUT);
      const originalUpdatedAt = entity.updatedAt;
      const originalBankName = entity.bankName;
      const originalClabe = entity.clabe;

      await new Promise((r) => setTimeout(r, 5));
      entity.update({ beneficiary: 'Nuevo Beneficiario' });

      expect(entity.beneficiary).toBe('Nuevo Beneficiario');
      expect(entity.bankName).toBe(originalBankName);
      expect(entity.clabe).toBe(originalClabe);
      expect(entity.isActive).toBe(true);
      expect(entity.updatedAt.getTime()).toBeGreaterThan(
        originalUpdatedAt.getTime(),
      );
    });

    it('trims incoming strings', () => {
      const entity = PaymentDetail.create(BASE_INPUT);
      entity.update({ bankName: '  Banamex  ' });
      expect(entity.bankName).toBe('Banamex');
    });

    it('validates supplied fields (CLABE)', () => {
      const entity = PaymentDetail.create(BASE_INPUT);
      expect(() => entity.update({ clabe: 'short' })).toThrow(
        InvalidArgumentError,
      );
    });

    it('validates supplied fields (accountNumber)', () => {
      const entity = PaymentDetail.create(BASE_INPUT);
      expect(() => entity.update({ accountNumber: 'short' })).toThrow(
        InvalidArgumentError,
      );
    });
  });

  describe('fromPersistence()', () => {
    it('round-trips every field', () => {
      const createdAt = new Date('2026-08-01T00:00:00.000Z');
      const updatedAt = new Date('2026-08-24T00:00:00.000Z');
      const entity = PaymentDetail.fromPersistence({
        id: 'pd-1',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
        isActive: false,
        createdAt,
        updatedAt,
      });

      expect(entity.id).toBe('pd-1');
      expect(entity.tenantId).toBe('tenant-1');
      expect(entity.bankName).toBe('BBVA');
      expect(entity.beneficiary).toBe('Tienda XYZ');
      expect(entity.clabe).toBe('012345678901234567');
      expect(entity.accountNumber).toBe('1234567890');
      expect(entity.isActive).toBe(false);
      expect(entity.createdAt).toEqual(createdAt);
      expect(entity.updatedAt).toEqual(updatedAt);
    });
  });

  describe('toResponse()', () => {
    it('serializes timestamps as ISO strings', () => {
      const entity = PaymentDetail.create(BASE_INPUT);
      const res = entity.toResponse();
      expect(typeof res.createdAt).toBe('string');
      expect(typeof res.updatedAt).toBe('string');
      expect(res.id).toBe('pd-1');
      expect(res.tenantId).toBe('tenant-1');
    });
  });

  describe('toPersistence()', () => {
    it('returns all fields needed by the Prisma adapter', () => {
      const entity = PaymentDetail.create(BASE_INPUT);
      const data = entity.toPersistence();
      expect(data).toEqual({
        id: 'pd-1',
        tenantId: 'tenant-1',
        bankName: 'BBVA',
        beneficiary: 'Tienda XYZ',
        clabe: '012345678901234567',
        accountNumber: '1234567890',
        isActive: true,
        createdAt: expect.any(Date),
        updatedAt: expect.any(Date),
      });
    });
  });
});
