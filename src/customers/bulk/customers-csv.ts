/**
 * customers-bulk-actions / T1 (S2) — CSV of the customers table for Excel in
 * Spanish (Mexico) (`docs/proposals/customers-bulk-actions-contract.md` §4.2,
 * §4.3, owner L2.5).
 *
 * - UTF-8 with BOM, comma separator, CRLF after every record (the header
 *   included), RFC 4180 quoting, no `sep=` line (it makes Excel ignore the BOM).
 * - Formula-injection guard (OWASP) on every user-text cell: a value starting
 *   with `=`, `+`, `-`, `@`, TAB or CR gets a leading `'`.
 * - Money: decimal pesos, `.` decimal point, 2 decimals, no `$`, no thousands
 *   separator (`78500` cents → `785.00`).
 * - Instants: local `YYYY-MM-DD HH:mm` (24 h) in the business timezone; the
 *   due day is already `YYYY-MM-DD`.
 * - CP: a digits-only value is written as the Excel text formula `="03100"`
 *   (keeps the leading zero); any other value is guarded text.
 * - Booleans `Sí` / `No`; `null` → empty cell; species `Perro, Gato, Otro`.
 */
import type {
  CustomerListingRow,
  CustomerSalesMetrics,
} from '../listing/customer-listing.types';

export const CUSTOMERS_CSV_BASE_HEADERS = [
  'ID cliente',
  'Nombre',
  'Apellido',
  'Razón social',
  'Lada',
  'Teléfono',
  'Correo',
  'Lista de precios',
  'RFC',
  'Régimen fiscal',
  'Forma de pago preferida',
  'Cliente de confianza',
  'Alta',
  'Colonia',
  'Municipio',
  'Ciudad',
  'Estado',
  'CP',
  'Mascotas activas',
  'Especies',
] as const;

/** Only with `read:Sale`, appended after `Especies` (absent otherwise). */
export const CUSTOMERS_CSV_METRIC_HEADERS = [
  'Deuda',
  'Deuda vencida',
  'Ventas vencidas',
  'Vencido desde',
  'Compras',
  'Total comprado',
  'Ticket promedio',
  'Última compra',
] as const;

const BOM = '\uFEFF';
const CRLF = '\r\n';

const SPECIES_LABELS: Record<string, string> = {
  DOG: 'Perro',
  CAT: 'Gato',
  OTHER: 'Otro',
};

/** RFC 4180: quote a field holding `,`, `"`, CR or LF; double inner quotes. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** OWASP CSV injection: neutralize a leading formula character. */
export function guardFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/** Integer cents → decimal pesos without float arithmetic. */
export function formatPesos(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function localParts(instant: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** Local business date `YYYY-MM-DD` of an instant. */
export function formatLocalDate(instant: Date, timeZone: string): string {
  const p = localParts(instant, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

/** ISO instant → local `YYYY-MM-DD HH:mm` (24 h). */
export function formatLocalDateTime(iso: string, timeZone: string): string {
  const p = localParts(new Date(iso), timeZone);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

/** Already-formatted cells → the CSV bytes (BOM + CRLF records). */
export function encodeCsv(
  headers: readonly string[],
  records: ReadonlyArray<readonly string[]>,
): Buffer {
  const lines = [headers, ...records].map(
    (cells) => cells.map(csvField).join(',') + CRLF,
  );
  return Buffer.from(BOM + lines.join(''), 'utf8');
}

/** User-entered text: guarded; `null` / absent → empty cell. */
function text(value: string | null | undefined): string {
  return value === null || value === undefined ? '' : guardFormula(value);
}

/** Owner L2.5: digits-only CP as `="03100"` so Excel keeps the zero. */
function zipCode(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return /^\d+$/.test(value) ? `="${value}"` : guardFormula(value);
}

function metricCells(m: CustomerSalesMetrics, timeZone: string): string[] {
  return [
    formatPesos(m.openDebtCents),
    formatPesos(m.overdueDebtCents),
    String(m.overdueCount),
    m.oldestOverdueDueDate ?? '',
    String(m.salesCount),
    formatPesos(m.totalSoldCents),
    m.averageTicketCents === null ? '' : formatPesos(m.averageTicketCents),
    m.lastPurchaseAt === null
      ? ''
      : formatLocalDateTime(m.lastPurchaseAt, timeZone),
  ];
}

function rowCells(
  row: CustomerListingRow,
  withMetrics: boolean,
  timeZone: string,
): string[] {
  const address = row.primaryAddress;
  const cells = [
    row.id,
    text(row.firstName),
    text(row.lastName),
    text(row.businessName),
    text(row.phoneCountryCode),
    text(row.phone),
    text(row.email),
    text(row.globalPriceList?.name),
    text(row.rfc),
    text(row.fiscalRegime),
    text(row.preferredPaymentMethod),
    row.isTrusted ? 'Sí' : 'No',
    formatLocalDateTime(row.createdAt, timeZone),
    text(address?.neighborhood),
    text(address?.municipality),
    text(address?.city),
    text(address?.state),
    zipCode(address?.zipCode),
    String(row.activePetsCount),
    row.petSpecies.map((s) => SPECIES_LABELS[s] ?? guardFormula(s)).join(', '),
  ];
  if (withMetrics && row.metrics) {
    cells.push(...metricCells(row.metrics, timeZone));
  } else if (withMetrics) {
    cells.push(...CUSTOMERS_CSV_METRIC_HEADERS.map(() => ''));
  }
  return cells;
}

export interface CustomersCsvOptions {
  /** The caller holds `read:Sale`: the 8 metric columns are present. */
  withMetrics: boolean;
  /** `PROMOTIONS_BUSINESS_TIMEZONE`. */
  timeZone: string;
}

/**
 * The listing rows → the CSV file. `matchedPetName` / `matchedAddressId` are
 * not exported (they explain a match on screen, contract §4.3).
 */
export function buildCustomersCsv(
  rows: readonly CustomerListingRow[],
  options: CustomersCsvOptions,
): Buffer {
  const headers: string[] = [
    ...CUSTOMERS_CSV_BASE_HEADERS,
    ...(options.withMetrics ? CUSTOMERS_CSV_METRIC_HEADERS : []),
  ];
  return encodeCsv(
    headers,
    rows.map((row) => rowCells(row, options.withMetrics, options.timeZone)),
  );
}
