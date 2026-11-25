/**
 * sales-history-redesign S11 — customer statement A4 on the shared kit:
 * sections, columns, labels, overdue mark, canceled payments, empty states,
 * fixed footer page numbers and repeated ledger headers, asserted through the
 * element tree. Yoga is mocked under Jest, so page FIT is measured outside
 * Jest (real render); these tests pin structure.
 */
import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
  Document,
  Page,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';
import { CustomerStatementA4Document } from './customer-statement-a4.document';
import type {
  CustomerStatementDto,
  CustomerStatementPaymentDto,
  CustomerStatementSaleDto,
} from '../../../sales/dto/customer-statement.dto';

const SOURCE = readFileSync(
  `${__dirname}/customer-statement-a4.document.tsx`,
  'utf8',
);

function saleRow(
  index: number,
  over: Partial<CustomerStatementSaleDto> = {},
): CustomerStatementSaleDto {
  return {
    id: `sale-${index}`,
    folio: `V-${index}`,
    confirmedAt: '2026-11-10T18:00:00.000Z',
    localDate: '2026-11-10',
    totalCents: 10_000,
    paidCents: 4_000,
    openDebtCents: 6_000,
    dueDate: '2026-11-20',
    paymentStatus: 'PARTIAL',
    paymentStatusLabel: 'Impaga',
    overdue: true,
    ...over,
  };
}

function paymentRow(
  index: number,
  over: Partial<CustomerStatementPaymentDto> = {},
): CustomerStatementPaymentDto {
  return {
    id: `pay-${index}`,
    paidAt: '2026-11-12T17:00:00.000Z',
    localDate: '2026-11-12',
    method: 'CASH',
    methodLabel: 'Efectivo',
    amountCents: 4_000,
    tenderedCents: 4_000,
    changeCents: 0,
    saleId: `sale-${index}`,
    saleFolio: `V-${index}`,
    saleCanceled: false,
    ...over,
  };
}

function makeStatement(
  over: Partial<CustomerStatementDto> = {},
): CustomerStatementDto {
  return {
    timeZone: 'America/Mexico_City',
    from: '2026-11-01',
    to: '2026-12-01',
    today: '2026-11-25',
    generatedAt: '2026-11-25T18:00:00.000Z',
    branchName: 'Sucursal Centro',
    customer: {
      id: 'cust-1',
      name: 'Rosa Pérez',
      phone: '+52 5512345678',
      email: 'rosa@example.com',
      rfc: 'PERR800101AAA',
      businessName: 'Rosa SA',
    },
    sales: [
      saleRow(1),
      saleRow(2, {
        paidCents: 10_000,
        openDebtCents: 0,
        paymentStatus: 'PAID',
        paymentStatusLabel: 'Pagada',
        overdue: false,
        dueDate: null,
      }),
      saleRow(3, {
        paidCents: 0,
        openDebtCents: 10_000,
        paymentStatus: 'CREDIT',
        paymentStatusLabel: 'Deuda',
        overdue: false,
        dueDate: '2026-12-05',
      }),
    ],
    periodTotals: {
      saleCount: 3,
      totalCents: 30_000,
      paidCents: 14_000,
      openDebtCents: 16_000,
      overdueSaleCount: 1,
      overdueDebtCents: 6_000,
    },
    currentDebt: {
      saleCount: 4,
      openDebtCents: 46_000,
      overdueSaleCount: 2,
      overdueDebtCents: 36_000,
    },
    payments: [
      paymentRow(1),
      paymentRow(9, {
        method: 'TRANSFER',
        methodLabel: 'Transferencia',
        amountCents: 2_500,
        tenderedCents: 2_500,
        saleCanceled: true,
      }),
      paymentRow(2, {
        amountCents: 7_500,
        tenderedCents: 8_000,
        changeCents: 500,
      }),
    ],
    paymentsTotalCents: 14_000,
    ...over,
  };
}

type AnyElement = ReactElement<Record<string, unknown>>;
const HOST = new Set<unknown>([Document, Page, Text, View]);

function walk(node: ReactNode, out: AnyElement[] = []): AnyElement[] {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child as ReactNode, out));
    return out;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return out;
  out.push(node);
  if (typeof node.type === 'function' && !HOST.has(node.type)) {
    walk((node.type as (props: unknown) => ReactNode)(node.props), out);
  } else {
    walk(node.props.children as ReactNode, out);
  }
  return out;
}

function textOf(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!isValidElement<{ children?: ReactNode }>(node)) {
    return typeof node === 'string' ? `${node} ` : '';
  }
  if (typeof node.type === 'function' && !HOST.has(node.type)) {
    return textOf((node.type as (props: unknown) => ReactNode)(node.props));
  }
  return textOf(node.props.children);
}

const elementsOf = (statement: CustomerStatementDto) =>
  walk(CustomerStatementA4Document({ statement }));
const renderText = (statement: CustomerStatementDto) =>
  textOf(CustomerStatementA4Document({ statement })).replace(/\s+/g, ' ');

interface Table {
  columns: { key: string; label: string }[];
  rows: { cells: Record<string, unknown> }[];
  total?: { cells: Record<string, unknown> };
  emptyText?: string;
}
const tablesOf = (statement: CustomerStatementDto): Table[] =>
  elementsOf(statement)
    .filter((el) => Array.isArray(el.props.columns) && 'rows' in el.props)
    .map((el) => el.props as unknown as Table);
const cellText = (cell: unknown): string =>
  typeof cell === 'string' ? cell : (cell as { text: string }).text;

describe('CustomerStatementA4Document', () => {
  it('renders a PDF buffer with magic bytes', async () => {
    const buffer = await renderToBuffer(
      <CustomerStatementA4Document statement={makeStatement()} />,
    );
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('composes the shared A4 kit with no remote assets', () => {
    expect(SOURCE).toContain("from '../shared/a4-kit'");
    expect(SOURCE).toContain('A4Page');
    expect(SOURCE).toContain('LedgerTable');
    expect(SOURCE).not.toContain('https://');
    expect(SOURCE).not.toContain('registerModernFont');
  });

  it('prints the header, customer data, period, generation date and branch', () => {
    const text = renderText(makeStatement());
    for (const expected of [
      'Estado de cuenta',
      'Rosa Pérez',
      '+52 5512345678',
      'rosa@example.com',
      'PERR800101AAA',
      'Rosa SA',
      'Sucursal Centro',
      '01 nov 2026',
      '01 dic 2026',
      '(fecha final excluida)',
      '25 nov 2026, 12:00',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('prints «—» for missing contact and fiscal data', () => {
    const text = renderText(
      makeStatement({
        customer: {
          id: 'c',
          name: 'Luis',
          phone: null,
          email: null,
          rfc: null,
          businessName: null,
        },
      }),
    );
    expect(text).toMatch(/Teléfono —/);
    expect(text).toMatch(/RFC —/);
  });

  it('prints the current open debt and its overdue part', () => {
    const text = renderText(makeStatement());
    expect(text).toContain('Deuda abierta actual');
    expect(text).toContain('$460.00');
    expect(text).toContain('Vencido');
    expect(text).toContain('$360.00');
  });

  it('sales table: columns, labels, overdue mark and period totals row', () => {
    const [sales] = tablesOf(makeStatement());

    expect(sales.columns.map((c) => c.label)).toEqual([
      'Folio',
      'Fecha',
      'Total',
      'Pagado',
      'Saldo',
      'Vence',
      'Estado',
    ]);
    expect(sales.rows.map((r) => cellText(r.cells.status))).toEqual([
      'Impaga',
      'Pagada',
      'Deuda',
    ]);
    expect(sales.rows[0].cells.dueDate).toMatchObject({
      text: '20 nov 2026',
      sub: 'Vencida',
      tone: 'danger',
    });
    expect(sales.rows[1].cells.dueDate).toBe('—');
    expect(cellText(sales.rows[2].cells.dueDate)).toBe('05 dic 2026');
    expect(
      (sales.rows[2].cells.dueDate as { sub?: string }).sub,
    ).toBeUndefined();
    expect(cellText(sales.rows[0].cells.date)).toBe('10 nov 2026');
    expect(sales.total?.cells).toMatchObject({
      folio: '3 ventas',
      total: '$300.00',
      paid: '$140.00',
    });
    expect(cellText(sales.total?.cells.debt)).toBe('$160.00');
  });

  it('payments table: date, sale folio, method, amount; canceled sale and change marked', () => {
    const [, payments] = tablesOf(makeStatement());

    expect(payments.columns.map((c) => c.label)).toEqual([
      'Fecha',
      'Venta',
      'Método',
      'Importe',
    ]);
    expect(payments.rows.map((r) => cellText(r.cells.method))).toEqual([
      'Efectivo',
      'Transferencia',
      'Efectivo',
    ]);
    expect(payments.rows[1].cells.sale).toMatchObject({
      text: 'V-9',
      sub: 'Venta cancelada',
      tone: 'danger',
    });
    expect(payments.rows[2].cells.amount).toMatchObject({
      text: '$75.00',
      sub: 'Recibido $80.00 · cambio $5.00',
    });
    expect(payments.total?.cells.amount).toBe('$140.00');
  });

  it('explains what the payments section excludes', () => {
    const text = renderText(makeStatement());
    expect(text).toContain(
      'Solo pagos recibidos. No incluye devoluciones a pagar ni devoluciones entregadas de ventas canceladas.',
    );
  });

  it('empty states: no sales, no payments, no debt', () => {
    const empty = makeStatement({
      sales: [],
      payments: [],
      paymentsTotalCents: 0,
      periodTotals: {
        saleCount: 0,
        totalCents: 0,
        paidCents: 0,
        openDebtCents: 0,
        overdueSaleCount: 0,
        overdueDebtCents: 0,
      },
      currentDebt: {
        saleCount: 0,
        openDebtCents: 0,
        overdueSaleCount: 0,
        overdueDebtCents: 0,
      },
    });
    const [sales, payments] = tablesOf(empty);
    const text = renderText(empty);

    expect(sales.rows).toEqual([]);
    expect(sales.total).toBeUndefined();
    expect(text).toContain('Sin ventas confirmadas en el periodo.');
    expect(payments.total).toBeUndefined();
    expect(text).toContain('Sin pagos recibidos en el periodo.');
    expect(text).toContain('Sin deuda abierta.');
  });

  it('paginates naturally: wrapping pages, fixed ledger headers and footer page numbers', () => {
    const many = makeStatement({
      sales: Array.from({ length: 120 }, (_, i) => saleRow(i)),
      payments: Array.from({ length: 80 }, (_, i) => paymentRow(i)),
    });
    const elements = elementsOf(many);
    const pages = elements.filter((el) => el.type === Page);
    const numbered = elements.filter(
      (el) => el.type === Text && typeof el.props.render === 'function',
    );
    const fixedHeaders = elements.filter(
      (el) =>
        el.type === View &&
        el.props.fixed === true &&
        !el.props.render &&
        isValidElement(el.props.children),
    );

    for (const page of pages) expect(page.props.wrap).toBe(true);
    expect(numbered).toHaveLength(pages.length);
    for (const el of numbered) {
      const render = el.props.render as (info: {
        pageNumber: number;
        totalPages: number;
      }) => string;
      expect(render({ pageNumber: 3, totalPages: 5 })).toBe('Página 3 de 5');
    }
    // one repeated header per ledger table (sales + payments)
    expect(
      fixedHeaders.filter((el) =>
        Array.isArray(
          (el.props.children as AnyElement).props?.columns as unknown,
        ),
      ),
    ).toHaveLength(2);
    expect(renderText(many)).not.toMatch(/Página \d+ de \d+/);
    // rows never split
    const rows = elements.filter(
      (el) => el.type === View && el.props.wrap === false,
    );
    expect(rows.length).toBeGreaterThanOrEqual(200);
  });

  it('repeats a compact header from page 2 naming the customer', () => {
    const header = elementsOf(makeStatement()).find(
      (el) =>
        el.type === View &&
        el.props.fixed === true &&
        typeof el.props.render === 'function',
    );
    const render = header?.props.render as (info: {
      pageNumber: number;
    }) => ReactNode;
    expect(render({ pageNumber: 1 })).toBeNull();
    expect(textOf(render({ pageNumber: 2 }))).toContain('Rosa Pérez');
  });
});
