import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ChargeSaleDto } from './charge-sale.dto';
import { AddSalePaymentDto } from './add-sale-payment.dto';
import { SettleRefundDto } from './settle-refund.dto';

/**
 * Cash-register closing / T4 — request-contract validation for the optional
 * `cashSessionId` binding. Only the three sales entry DTOs that can carry an
 * explicit POS session are covered.
 *
 * Omission preserves legacy behavior; an explicit null is invalid, not an
 * instruction to bypass the POS session binding.
 */
const SESSION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('cashSessionId DTO validation', () => {
  const expectSessionErrors = async (
    dto: object,
  ): Promise<{ properties: string[]; messages: string[] }> => {
    const errors = await validate(dto);
    const sessionErrors = errors.filter(
      (error) => error.property === 'cashSessionId',
    );

    return {
      properties: errors.map((error) => error.property),
      messages: sessionErrors.flatMap((error) =>
        Object.values(error.constraints ?? {}),
      ),
    };
  };

  describe('ChargeSaleDto', () => {
    const charge = (cashSessionId: unknown): ChargeSaleDto =>
      plainToInstance(ChargeSaleDto, {
        method: 'cash',
        amountCents: 1000,
        cashSessionId,
      });

    it('accepts an omitted session (legacy charge) with no validation errors', async () => {
      const errors = await validate(
        plainToInstance(ChargeSaleDto, { method: 'cash', amountCents: 1000 }),
      );

      expect(errors).toHaveLength(0);
    });

    it('accepts a well-formed UUID session and keeps it on the instance', async () => {
      const dto = charge(SESSION_ID);
      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.cashSessionId).toBe(SESSION_ID);
    });

    it('rejects a malformed session with INVALID_CASH_SESSION_ID', async () => {
      const { properties, messages } = await expectSessionErrors(
        charge('caja-1'),
      );

      expect(properties).toContain('cashSessionId');
      expect(messages).toContain('INVALID_CASH_SESSION_ID');
    });

    it('rejects a numeric session value', async () => {
      const { messages } = await expectSessionErrors(charge(123));

      expect(messages).toContain('INVALID_CASH_SESSION_ID');
    });

    it('rejects an explicit null session', async () => {
      const { messages } = await expectSessionErrors(charge(null));

      expect(messages).toContain('INVALID_CASH_SESSION_ID');
    });
  });

  describe('AddSalePaymentDto', () => {
    const payment = (cashSessionId: unknown): AddSalePaymentDto =>
      plainToInstance(AddSalePaymentDto, {
        method: 'cash',
        amountCents: 2000,
        cashSessionId,
      });

    it('accepts an omitted session (legacy collection) with no validation errors', async () => {
      const errors = await validate(
        plainToInstance(AddSalePaymentDto, {
          method: 'cash',
          amountCents: 2000,
        }),
      );

      expect(errors).toHaveLength(0);
    });

    it('accepts a well-formed UUID session', async () => {
      const dto = payment(SESSION_ID);

      expect(await validate(dto)).toHaveLength(0);
      expect(dto.cashSessionId).toBe(SESSION_ID);
    });

    it('rejects a malformed session with INVALID_CASH_SESSION_ID', async () => {
      const { messages } = await expectSessionErrors(payment('not-a-uuid'));

      expect(messages).toContain('INVALID_CASH_SESSION_ID');
    });

    it('rejects a malformed session in the payments[] shape too', async () => {
      const dto = plainToInstance(AddSalePaymentDto, {
        payments: [{ method: 'cash', amountCents: 1000 }],
        cashSessionId: 'nope',
      });
      const { messages } = await expectSessionErrors(dto);

      expect(messages).toContain('INVALID_CASH_SESSION_ID');
    });

    it('rejects an explicit null session', async () => {
      const { messages } = await expectSessionErrors(payment(null));

      expect(messages).toContain('INVALID_CASH_SESSION_ID');
    });
  });

  describe('SettleRefundDto', () => {
    const refund = (cashSessionId: unknown): SettleRefundDto =>
      plainToInstance(SettleRefundDto, {
        amountCents: 500,
        method: 'cash',
        reference: 'REF-1',
        settledAt: '2024-01-15T10:00:00.000Z',
        cashSessionId,
      });

    it('accepts an omitted session (legacy refund) with no validation errors', async () => {
      const dto = plainToInstance(SettleRefundDto, {
        amountCents: 500,
        method: 'cash',
        settledAt: '2024-01-15T10:00:00.000Z',
      });

      expect(await validate(dto)).toHaveLength(0);
    });

    it('accepts a well-formed UUID session', async () => {
      const dto = refund(SESSION_ID);

      expect(await validate(dto)).toHaveLength(0);
      expect(dto.cashSessionId).toBe(SESSION_ID);
    });

    it('rejects a malformed session with INVALID_CASH_SESSION_ID', async () => {
      const { messages } = await expectSessionErrors(refund('refund-1'));

      expect(messages).toContain('INVALID_CASH_SESSION_ID');
    });

    it('rejects an explicit null session', async () => {
      const { messages } = await expectSessionErrors(refund(null));

      expect(messages).toContain('INVALID_CASH_SESSION_ID');
    });
  });
});
