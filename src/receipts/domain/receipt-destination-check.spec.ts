import {
  computeDestinationCheck,
  hasDestinationEvidence,
  namesMatch,
  readDestinationCheck,
  type ActivePaymentAccount,
} from './receipt-destination-check';

/** S1: the tenant's active payment detail, verbatim. */
const MERCADO_PAGO: ActivePaymentAccount = {
  beneficiary: 'Diana berenice Vazquez',
  clabe: '722969010558166876',
  accountNumber: '5428785112374268',
};
const OTHER: ActivePaymentAccount = {
  beneficiary: 'Tienda Houndfe SA de CV',
  clabe: '012180001234567891',
  accountNumber: '0123-4567-0042',
};

describe('computeDestinationCheck', () => {
  it('flags S1: card ****9616 to «Abril Alejandra Vazquez Ramos» is not the business account', () => {
    expect(
      computeDestinationCheck({
        destinationAccountLast4: '9616',
        destinationName: 'Abril Alejandra Vazquez Ramos',
        accounts: [MERCADO_PAGO],
      }),
    ).toBe('mismatch');
  });

  it.each([
    ['the CLABE', '6876'],
    ['the account number', '4268'],
  ])('matches last4 against %s of an active account', (_label, last4) => {
    expect(
      computeDestinationCheck({
        destinationAccountLast4: last4,
        accounts: [MERCADO_PAGO],
      }),
    ).toBe('match');
  });

  it('matches last4 against any active account, ignoring separators', () => {
    expect(
      computeDestinationCheck({
        destinationAccountLast4: '0042',
        accounts: [MERCADO_PAGO, OTHER],
      }),
    ).toBe('match');
  });

  it('lets last4 decide over the name (a matching name never rescues bad digits)', () => {
    expect(
      computeDestinationCheck({
        destinationAccountLast4: '9616',
        destinationName: 'Diana Berenice Vázquez',
        accounts: [MERCADO_PAGO],
      }),
    ).toBe('mismatch');
    expect(
      computeDestinationCheck({
        destinationAccountLast4: '6876',
        destinationName: 'Abril Alejandra Vazquez Ramos',
        accounts: [MERCADO_PAGO],
      }),
    ).toBe('match');
  });

  it('falls back to the name when last4 is absent (S1 names)', () => {
    expect(
      computeDestinationCheck({
        destinationName: 'Abril Alejandra Vazquez Ramos',
        accounts: [MERCADO_PAGO],
      }),
    ).toBe('mismatch');
    expect(
      computeDestinationCheck({
        destinationName: 'Diana Berenice Vázquez',
        accounts: [MERCADO_PAGO],
      }),
    ).toBe('match');
    expect(
      computeDestinationCheck({
        destinationName: 'TIENDA HOUNDFE, S.A. DE C.V.',
        accounts: [MERCADO_PAGO, OTHER],
      }),
    ).toBe('match');
  });

  it('is unknown without last4 and name, or without active accounts', () => {
    expect(computeDestinationCheck({ accounts: [MERCADO_PAGO] })).toBe(
      'unknown',
    );
    expect(
      computeDestinationCheck({
        destinationAccountLast4: '9616',
        destinationName: 'Abril Alejandra Vazquez Ramos',
        accounts: [],
      }),
    ).toBe('unknown');
  });
});

describe('namesMatch', () => {
  it.each([
    ['Abril Alejandra Vazquez Ramos', 'Diana berenice Vazquez', false],
    ['Diana Berenice Vázquez', 'Diana berenice Vazquez', true],
    ['DIANA BERENICE V', 'Diana berenice Vazquez', true],
    ['Diana Vazquez', 'Diana berenice Vazquez', true],
    ['Juan Vazquez', 'Diana berenice Vazquez', false],
    ['Diana', 'Diana berenice Vazquez', true],
    ['Ana', 'Diana berenice Vazquez', false],
    ['  diana.  berenice--vázquez ', 'Diana berenice Vazquez', true],
    ['de la', 'Diana de la Vazquez', false],
    ['', 'Diana berenice Vazquez', false],
  ])('%j vs %j -> %s', (a, b, expected) => {
    expect(namesMatch(a, b)).toBe(expected);
    expect(namesMatch(b, a)).toBe(expected);
  });
});

describe('hasDestinationEvidence', () => {
  it('is true only with last4 or destinationName (bank and originName never decide)', () => {
    expect(hasDestinationEvidence(null)).toBe(false);
    expect(
      hasDestinationEvidence({ destinationBank: 'BBVA', originName: 'Ana' }),
    ).toBe(false);
    expect(hasDestinationEvidence({ destinationAccountLast4: '1234' })).toBe(
      true,
    );
    expect(hasDestinationEvidence({ destinationName: 'Diana' })).toBe(true);
  });
});

describe('readDestinationCheck', () => {
  it('reads the persisted value and treats older rows as unknown', () => {
    expect(
      readDestinationCheck({
        debtCents: 1,
        flagged: false,
        destinationCheck: 'mismatch',
      }),
    ).toBe('mismatch');
    expect(readDestinationCheck({ debtCents: 1, flagged: false })).toBe(
      'unknown',
    );
    expect(readDestinationCheck(null)).toBe('unknown');
    expect(readDestinationCheck({ destinationCheck: 'bogus' })).toBe('unknown');
  });
});
