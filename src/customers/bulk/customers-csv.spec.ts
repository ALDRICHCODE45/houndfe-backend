import type { CustomerListingRow } from '../listing/customer-listing.types';
import {
  CUSTOMERS_CSV_BASE_HEADERS,
  CUSTOMERS_CSV_METRIC_HEADERS,
  buildCustomersCsv,
  csvField,
  encodeCsv,
  formatLocalDate,
  formatLocalDateTime,
  formatPesos,
  guardFormula,
} from './customers-csv';

const TZ = 'America/Mexico_City';
const BOM = '\uFEFF';

function row(over: Partial<CustomerListingRow> = {}): CustomerListingRow {
  return {
    id: '3f2a9c1e-0000-4000-8000-000000000001',
    firstName: 'Ana',
    lastName: 'López',
    businessName: null,
    phoneCountryCode: '52',
    phone: '5512345678',
    email: 'ana@example.com',
    globalPriceList: { id: 'pl', name: 'Mayoreo' },
    rfc: 'LOAA800101XXX',
    fiscalRegime: '612',
    preferredPaymentMethod: 'transferencia',
    isTrusted: true,
    createdAt: '2026-03-02T17:04:11.000Z',
    primaryAddress: {
      id: 'addr',
      neighborhood: 'Del Valle',
      municipality: 'Benito Juárez',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      zipCode: '03100',
    },
    activePetsCount: 2,
    petSpecies: ['DOG', 'CAT'],
    matchedPetName: 'Firulais',
    matchedAddressId: 'addr',
    ...over,
  };
}

const metrics = {
  openDebtCents: 78500,
  overdueDebtCents: 30000,
  overdueCount: 1,
  oldestOverdueDueDate: '2026-11-01',
  salesCount: 14,
  totalSoldCents: 1250000,
  averageTicketCents: 89286,
  lastPurchaseAt: '2026-11-20T19:31:02.000Z',
};

describe('customers CSV (contract §4.2, §4.3, owner L2.5)', () => {
  describe('RFC 4180 field quoting', () => {
    it.each([
      ['plain', 'plain'],
      ['', ''],
      ['a,b', '"a,b"'],
      ['say "hi"', '"say ""hi"""'],
      ['line\nbreak', '"line\nbreak"'],
      ['cr\rhere', '"cr\rhere"'],
      ['López Ñandú', 'López Ñandú'],
    ])('%j → %j', (value, expected) => {
      expect(csvField(value)).toBe(expected);
    });
  });

  describe('formula-injection guard (OWASP)', () => {
    it.each([
      ['=HYPERLINK("x")', `'=HYPERLINK("x")`],
      ['+5215512345678', `'+5215512345678`],
      ['-1', `'-1`],
      ['@SUM(A1)', `'@SUM(A1)`],
      ['\tTab', `'\tTab`],
      ['\rCR', `'\rCR`],
      ['Ana', 'Ana'],
      [' =not first', ' =not first'],
      ['a=b', 'a=b'],
    ])('%j → %j', (value, expected) => {
      expect(guardFormula(value)).toBe(expected);
    });
  });

  describe('value formats', () => {
    it.each([
      [78500, '785.00'],
      [0, '0.00'],
      [5, '0.05'],
      [123456789, '1234567.89'],
      [-150, '-1.50'],
    ])(
      'money %d cents → %s pesos (no $, no thousands separator)',
      (cents, expected) => {
        expect(formatPesos(cents)).toBe(expected);
      },
    );

    it('instants → local YYYY-MM-DD HH:mm 24 h in the business timezone', () => {
      expect(formatLocalDateTime('2026-03-02T17:04:11.000Z', TZ)).toBe(
        '2026-03-02 11:04',
      );
      // 05:59Z is still the previous local day (UTC-6).
      expect(formatLocalDateTime('2026-11-27T05:59:00.000Z', TZ)).toBe(
        '2026-11-26 23:59',
      );
      expect(formatLocalDateTime('2026-11-27T06:00:00.000Z', TZ)).toBe(
        '2026-11-27 00:00',
      );
    });

    it('local business date of an instant', () => {
      expect(formatLocalDate(new Date('2026-11-27T05:59:00.000Z'), TZ)).toBe(
        '2026-11-26',
      );
      expect(formatLocalDate(new Date('2026-11-27T06:00:00.000Z'), TZ)).toBe(
        '2026-11-27',
      );
    });
  });

  describe('encodeCsv', () => {
    it('UTF-8 with BOM, comma separator, CRLF after every record, no sep= line', () => {
      const buffer = encodeCsv(['a', 'b c'], [['1', 'x,y']]);
      expect([...buffer.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      expect(buffer.toString('utf8')).toBe(`${BOM}a,b c\r\n1,"x,y"\r\n`);
    });
  });

  describe('buildCustomersCsv', () => {
    it('without read:Sale: the 20 base columns only, Spanish headers in contract order', () => {
      const text = buildCustomersCsv([row()], {
        withMetrics: false,
        timeZone: TZ,
      }).toString('utf8');
      const [header, line, rest] = text.slice(1).split('\r\n');
      expect(header).toBe(
        'ID cliente,Nombre,Apellido,Razón social,Lada,Teléfono,Correo,Lista de precios,RFC,Régimen fiscal,Forma de pago preferida,Cliente de confianza,Alta,Colonia,Municipio,Ciudad,Estado,CP,Mascotas activas,Especies',
      );
      expect(header.split(',')).toEqual([...CUSTOMERS_CSV_BASE_HEADERS]);
      expect(line).toBe(
        '3f2a9c1e-0000-4000-8000-000000000001,Ana,López,,52,5512345678,ana@example.com,Mayoreo,LOAA800101XXX,612,transferencia,Sí,2026-03-02 11:04,Del Valle,Benito Juárez,Ciudad de México,Ciudad de México,"=""03100""",2,"Perro, Gato"',
      );
      expect(rest).toBe('');
      expect(text).not.toContain('Firulais');
      expect(text).not.toContain('addr');
    });

    it('with read:Sale: the 8 metric columns appended after Especies', () => {
      const text = buildCustomersCsv([row({ metrics })], {
        withMetrics: true,
        timeZone: TZ,
      }).toString('utf8');
      const [header, line] = text.slice(1).split('\r\n');
      expect(
        header.endsWith(
          ',Especies,Deuda,Deuda vencida,Ventas vencidas,Vencido desde,Compras,Total comprado,Ticket promedio,Última compra',
        ),
      ).toBe(true);
      expect([...CUSTOMERS_CSV_METRIC_HEADERS]).toEqual([
        'Deuda',
        'Deuda vencida',
        'Ventas vencidas',
        'Vencido desde',
        'Compras',
        'Total comprado',
        'Ticket promedio',
        'Última compra',
      ]);
      expect(
        line.endsWith(
          ',"Perro, Gato",785.00,300.00,1,2026-11-01,14,12500.00,892.86,2026-11-20 13:31',
        ),
      ).toBe(true);
    });

    it('a customer without sales: null metrics are empty cells, counts/sums 0', () => {
      const text = buildCustomersCsv(
        [
          row({
            metrics: {
              openDebtCents: 0,
              overdueDebtCents: 0,
              overdueCount: 0,
              oldestOverdueDueDate: null,
              salesCount: 0,
              totalSoldCents: 0,
              averageTicketCents: null,
              lastPurchaseAt: null,
            },
          }),
        ],
        { withMetrics: true, timeZone: TZ },
      ).toString('utf8');
      expect(
        text.slice(1).split('\r\n')[1].endsWith(',0.00,0.00,0,,0,0.00,,'),
      ).toBe(true);
    });

    it('nulls → empty cells; no address → empty address columns; no pets → empty species', () => {
      const text = buildCustomersCsv(
        [
          row({
            lastName: null,
            phoneCountryCode: null,
            phone: null,
            email: null,
            globalPriceList: null,
            rfc: null,
            fiscalRegime: null,
            preferredPaymentMethod: null,
            isTrusted: false,
            primaryAddress: null,
            activePetsCount: 0,
            petSpecies: [],
          }),
        ],
        { withMetrics: false, timeZone: TZ },
      ).toString('utf8');
      expect(text.slice(1).split('\r\n')[1]).toBe(
        '3f2a9c1e-0000-4000-8000-000000000001,Ana,,,,,,,,,,No,2026-03-02 11:04,,,,,,0,',
      );
    });

    it('CP: digits-only → ="…" text formula; anything else is guarded text', () => {
      const line = (zipCode: string | null) =>
        buildCustomersCsv(
          [
            row({
              primaryAddress: {
                id: 'a',
                neighborhood: null,
                municipality: null,
                city: null,
                state: null,
                zipCode,
              },
            }),
          ],
          { withMetrics: false, timeZone: TZ },
        )
          .toString('utf8')
          .slice(1)
          .split('\r\n')[1]
          .split(',')[17];
      expect(line('03100')).toBe('"=""03100"""');
      expect(line('C.P. 44100')).toBe('C.P. 44100');
      expect(line('=1+1')).toBe(`'=1+1`);
      expect(line('')).toBe('');
      expect(line(null)).toBe('');
    });

    it('guards every user-text column and still RFC-quotes the result', () => {
      const evil = '=HYPERLINK("http://x","y")';
      const text = buildCustomersCsv(
        [
          row({
            firstName: evil,
            lastName: '+1',
            businessName: '-2',
            email: '@3',
            rfc: '=4',
            phone: '+5',
            phoneCountryCode: '+52',
            globalPriceList: { id: 'p', name: '=6' },
            preferredPaymentMethod: '=7',
            fiscalRegime: '=8',
            primaryAddress: {
              id: 'a',
              neighborhood: '=9',
              municipality: '=10',
              city: '=11',
              state: '=12',
              zipCode: '03100',
            },
          }),
        ],
        { withMetrics: false, timeZone: TZ },
      ).toString('utf8');
      const line = text.slice(1).split('\r\n')[1];
      expect(line).toBe(
        `3f2a9c1e-0000-4000-8000-000000000001,"'=HYPERLINK(""http://x"",""y"")",'+1,'-2,'+52,'+5,'@3,'=6,'=4,'=8,'=7,Sí,2026-03-02 11:04,'=9,'=10,'=11,'=12,"=""03100""",2,"Perro, Gato"`,
      );
    });

    it('accents, commas, quotes and newlines in names survive', () => {
      const text = buildCustomersCsv(
        [
          row({
            firstName: 'José "Pepe"',
            businessName: 'Croquetas, S.A.\nde C.V.',
          }),
        ],
        { withMetrics: false, timeZone: TZ },
      ).toString('utf8');
      expect(text).toContain('"José ""Pepe"""');
      expect(text).toContain('"Croquetas, S.A.\nde C.V."');
    });

    it('species labels in enum order: Perro, Gato, Otro', () => {
      const text = buildCustomersCsv(
        [row({ petSpecies: ['DOG', 'CAT', 'OTHER'] })],
        { withMetrics: false, timeZone: TZ },
      ).toString('utf8');
      expect(text).toContain(',"Perro, Gato, Otro"\r\n');
    });

    it('an empty result is the header row only', () => {
      expect(
        buildCustomersCsv([], { withMetrics: false, timeZone: TZ }).toString(
          'utf8',
        ),
      ).toBe(`${BOM}${CUSTOMERS_CSV_BASE_HEADERS.join(',')}\r\n`);
    });
  });
});
