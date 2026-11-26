/**
 * customer-collection / T3 (S5) — «Comprobante de cobro» (contract v1 §7,
 * owner Q5): props mapping and the ticket / A4 documents, asserted through the
 * element tree. Yoga is mocked under Jest, so page FIT is measured outside
 * Jest (real render); these tests pin structure and content.
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
import type { CollectionReceiptDto } from '../../../sales/dto/customer-collection.dto';
import { buildCollectionReceiptProps } from './collection-receipt.props';
import { CollectionReceiptTicketDocument } from './collection-receipt-ticket.document';
import { CollectionReceiptA4Document } from './collection-receipt-a4.document';
import type { CollectionReceiptProps } from './collection-receipt.types';

const COLLECTION_ID = '1a2b3c4d-0000-4000-8000-000000000001';

function receipt(over: Partial<CollectionReceiptDto['collection']> = {}) {
  const dto: CollectionReceiptDto = {
    branchName: 'Sucursal Centro',
    cashierName: 'Cajera Uno',
    collection: {
      collectionId: COLLECTION_ID,
      customer: { id: 'cus-1', name: 'Ana López' },
      createdAt: '2026-11-25T18:05:00.000Z',
      tenderedCents: 100_000,
      appliedCents: 90_000,
      changeDueCents: 10_000,
      payments: [
        {
          method: 'card_debit',
          amountCents: 60_000,
          catalog: {
            paymentMethodId: 'pm-1',
            name: 'BBVA Débito',
            subtitle: 'Terminal 2',
          },
        },
        { method: 'transfer', amountCents: 10_000, catalog: null },
        { method: 'cash', amountCents: 30_000, catalog: null },
      ],
      sales: [
        {
          saleId: 's-1',
          folio: 'V-000123',
          confirmedAt: '2026-10-01T15:00:00.000Z',
          dueDate: '2026-11-01T00:00:00.000Z',
          overdue: true,
          appliedCents: 30_000,
          paidCents: 30_000,
          debtCents: 0,
          paymentStatus: 'PAID',
          paymentIds: ['p-1'],
          saleStatus: 'CONFIRMED',
        },
        {
          saleId: 's-2',
          folio: 'V-000130',
          confirmedAt: '2026-10-02T15:00:00.000Z',
          dueDate: null,
          overdue: false,
          appliedCents: 60_000,
          paidCents: 60_000,
          debtCents: 25_000,
          paymentStatus: 'PARTIAL',
          paymentIds: ['p-2', 'p-3'],
          saleStatus: 'CANCELED',
        },
      ],
      remainingCustomerDebtCents: 25_000,
      ...over,
    },
  };
  return dto;
}

const props = (over: Partial<CollectionReceiptDto['collection']> = {}) =>
  buildCollectionReceiptProps(receipt(over), 'HoundFe');

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
    walk((node.type as (p: unknown) => ReactNode)(node.props), out);
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
    return textOf((node.type as (p: unknown) => ReactNode)(node.props));
  }
  return textOf(node.props.children);
}

const ticketText = (p: CollectionReceiptProps) =>
  textOf(CollectionReceiptTicketDocument(p)).replace(/\s+/g, ' ');
const a4Text = (p: CollectionReceiptProps) =>
  textOf(CollectionReceiptA4Document(p)).replace(/\s+/g, ' ');

describe('buildCollectionReceiptProps', () => {
  it('maps branch, short folio, cashier, customer, sales, tenders and totals', () => {
    expect(props()).toEqual({
      brandName: 'HoundFe',
      branchName: 'Sucursal Centro',
      folio: 'COB-1A2B3C4D',
      date: '2026-11-25T18:05:00.000Z',
      cashier: 'Cajera Uno',
      customerName: 'Ana López',
      sales: [
        {
          folio: 'V-000123',
          appliedCents: 30_000,
          debtAfterCents: 0,
          canceled: false,
        },
        {
          folio: 'V-000130',
          appliedCents: 60_000,
          debtAfterCents: 25_000,
          canceled: true,
        },
      ],
      tenders: [
        { label: 'BBVA Débito', subtitle: 'Terminal 2', amountCents: 60_000 },
        { label: 'Transferencia', subtitle: null, amountCents: 10_000 },
        { label: 'Efectivo', subtitle: null, amountCents: 30_000 },
      ],
      tenderedCents: 100_000,
      appliedCents: 90_000,
      changeDueCents: 10_000,
      remainingCustomerDebtCents: 25_000,
    });
  });

  it('falls back to the method label without catalog (or with a blank catalog name)', () => {
    const p = props({
      payments: [
        {
          method: 'card_credit',
          amountCents: 50_000,
          catalog: { paymentMethodId: 'pm-2', name: '  ' },
        },
        { method: 'card_debit', amountCents: 40_000, catalog: null },
      ],
      tenderedCents: 90_000,
      changeDueCents: 0,
    });
    expect(p.tenders).toEqual([
      { label: 'Tarjeta de crédito', subtitle: null, amountCents: 50_000 },
      { label: 'Tarjeta de débito', subtitle: null, amountCents: 40_000 },
    ]);
  });

  it('deleted customer, missing cashier, missing folio', () => {
    const dto = receipt({ customer: null, remainingCustomerDebtCents: null });
    dto.cashierName = null;
    dto.collection.sales[0].folio = null;
    const p = buildCollectionReceiptProps(dto, 'HoundFe');
    expect(p.customerName).toBe('Cliente eliminado');
    expect(p.cashier).toBe('—');
    expect(p.sales[0].folio).toBe('—');
    expect(p.remainingCustomerDebtCents).toBeNull();
  });
});

describe('CollectionReceiptTicketDocument', () => {
  const SOURCE = readFileSync(
    `${__dirname}/collection-receipt-ticket.document.tsx`,
    'utf8',
  );

  it('renders a PDF buffer with magic bytes', async () => {
    const buffer = await renderToBuffer(
      <CollectionReceiptTicketDocument {...props()} />,
    );
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('reuses the receipt ticket kit on a width-only (single continuous) page', () => {
    expect(SOURCE).toContain("from '../receipt/ticket-kit'");
    const pages = walk(CollectionReceiptTicketDocument(props())).filter(
      (el) => el.type === Page,
    );
    expect(pages).toHaveLength(1);
    expect(pages[0].props.size).toEqual({ width: 227 });
    expect(pages[0].props.wrap).toBe(false);
  });

  it('prints branch, date, cashier, customer, every sale, tenders, received, change, totals and customer debt', () => {
    const text = ticketText(props());
    for (const expected of [
      'COBRO',
      'FOLIO #COB-1A2B3C4D',
      'SUCURSAL Sucursal Centro',
      'FECHA 25 nov 2026, 12:05',
      'CAJERO Cajera Uno',
      'CLIENTE Ana López',
      'V-000123',
      '$300.00',
      'Resta $0.00',
      'V-000130',
      'CANCELADA',
      'Resta $250.00',
      'BBVA Débito',
      'Terminal 2',
      'Transferencia',
      'Efectivo',
      'Recibido $1,000.00',
      'Cambio $100.00',
      'TOTAL $900.00',
      'Deuda del cliente $250.00',
      'COMPROBANTE DE COBRO',
      'Gracias por su pago.',
    ]) {
      expect(text).toContain(expected);
    }
    // The first sale is not cancelled: «CANCELADA» appears exactly once.
    expect(text.match(/CANCELADA/g)).toHaveLength(1);
  });

  it('omits the change row without change, prints a settled customer and an unknown debt', () => {
    const settled = ticketText(
      props({ changeDueCents: 0, remainingCustomerDebtCents: 0 }),
    );
    expect(settled).not.toContain('Cambio');
    expect(settled).toContain('Deuda del cliente $0.00');

    const unknown = ticketText(
      props({ customer: null, remainingCustomerDebtCents: null }),
    );
    expect(unknown).toContain('CLIENTE Cliente eliminado');
    expect(unknown).toContain('Deuda del cliente No disponible');
  });
});

describe('CollectionReceiptA4Document', () => {
  const SOURCE = readFileSync(
    `${__dirname}/collection-receipt-a4.document.tsx`,
    'utf8',
  );

  it('renders a PDF buffer with magic bytes', async () => {
    const buffer = await renderToBuffer(
      <CollectionReceiptA4Document {...props()} />,
    );
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('composes the shared A4 kit with no remote assets', () => {
    expect(SOURCE).toContain("from '../shared/a4-kit'");
    expect(SOURCE).toContain('A4Page');
    expect(SOURCE).toContain('LedgerTable');
    expect(SOURCE).not.toContain('https://');
  });

  it('lists every sale (cancelled marked in danger) with applied and remaining debt, then totals and tenders', () => {
    const elements = walk(CollectionReceiptA4Document(props()));
    const table = elements.find(
      (el) => Array.isArray(el.props.columns) && 'rows' in el.props,
    )!.props as unknown as {
      columns: { key: string; label: string }[];
      rows: { cells: Record<string, unknown> }[];
      total: { cells: Record<string, unknown> };
    };
    expect(table.columns.map((c) => c.label)).toEqual([
      'Venta',
      'Estado',
      'Abonado',
      'Resta tras el cobro',
    ]);
    expect(table.rows.map((r) => r.cells)).toEqual([
      {
        folio: 'V-000123',
        status: 'Pagada',
        applied: { text: '$300.00', bold: true },
        debt: '$0.00',
      },
      {
        folio: 'V-000130',
        status: { text: 'Cancelada', tone: 'danger' },
        applied: { text: '$600.00', bold: true },
        debt: '$250.00',
      },
    ]);
    expect(table.total.cells).toEqual({
      folio: 'Total abonado',
      applied: '$900.00',
    });

    const text = a4Text(props());
    for (const expected of [
      'Comprobante de cobro',
      'Folio #COB-1A2B3C4D',
      'Sucursal Centro',
      '25 nov 2026, 12:05',
      'Cajera Uno',
      'Ana López',
      'Recibido',
      '$1,000.00',
      'Cambio',
      '$100.00',
      'Deuda del cliente',
      '$250.00',
      'BBVA Débito',
      'Terminal 2',
      'Transferencia',
      'Efectivo',
      'Gracias por su pago.',
    ]) {
      expect(text).toContain(expected);
    }
  });

  it('partial sale reads «Parcial»; no change row without change; unknown debt reads «No disponible»', () => {
    const p = props({ changeDueCents: 0, remainingCustomerDebtCents: null });
    p.sales[1].canceled = false;
    const text = a4Text(p);
    expect(text).toContain('Parcial');
    expect(text).not.toContain('Cambio');
    expect(text).toContain('No disponible');
  });
});
