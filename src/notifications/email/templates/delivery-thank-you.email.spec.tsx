/**
 * delivery-thank-you.email.spec.tsx — delivery-routes / DTE-3.
 *
 * Pins the customer-facing thank-you email contract: the static Spanish
 * subject, the optional folio / variant / customer-name fallbacks, es-MX
 * formatting of the PERSISTED MXN cents (the NET `lineTotalCents` is
 * rendered verbatim and the per-line discount is never subtracted a
 * second time), and the absence of internal ids, email, address,
 * paid/debt claim, platform logo and platform-business copy.
 *
 * The DTE-2 projection (`sale-delivery-summary.port.ts`) is the only data
 * shape this template renders; the spec builds it directly instead of
 * reaching a database.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  SaleDeliverySummary,
  SaleDeliverySummaryItem,
} from '../../../delivery-routes/domain/ports/sale-delivery-summary.port';
import {
  DeliveryThankYouEmail,
  composeDeliveryThankYouSubject,
  formatMxnCents,
  type DeliveryThankYouEmailProps,
} from './delivery-thank-you.email';

/** Canonical persisted line: no discount, so it renders at face value. */
const BASE_ITEM: SaleDeliverySummaryItem = {
  productName: 'Café molido',
  variantName: '500 g',
  quantity: 2,
  unitPriceCents: 12500,
  lineTotalCents: 25000,
  discountAmountCents: null,
  discountTitle: null,
  rewardKind: null,
};

/** Persisted line without a variant (the table must stay aligned). */
const BASE_ITEM_2: SaleDeliverySummaryItem = {
  productName: 'Taza cerámica',
  variantName: null,
  quantity: 1,
  unitPriceCents: 5000,
  lineTotalCents: 5000,
  discountAmountCents: null,
  discountTitle: null,
  rewardKind: null,
};

function baseSummary(
  overrides: Partial<SaleDeliverySummary> = {},
): SaleDeliverySummary {
  return {
    saleId: '5f4d1f7a-1111-4c2b-9a10-abc123456789',
    folio: 'A-1001',
    confirmedAt: new Date('2026-08-01T12:00:00.000Z'),
    currency: 'MXN',
    subtotalCents: 30000,
    discountCents: 0,
    totalCents: 30000,
    customerName: 'Ada Lovelace',
    items: [BASE_ITEM, BASE_ITEM_2],
    ...overrides,
  };
}

function render(props: Partial<DeliveryThankYouEmailProps> = {}): string {
  return renderToStaticMarkup(
    <DeliveryThankYouEmail
      summary={props.summary ?? baseSummary()}
      tenantName={props.tenantName}
    />,
  );
}

describe('delivery-thank-you email template (DTE-3)', () => {
  it('uses the static Spanish subject in the composer, title and heading', () => {
    const html = render();
    expect(composeDeliveryThankYouSubject()).toBe('Gracias por tu compra');
    expect(html).toContain('<title>Gracias por tu compra</title>');
    expect(html).toContain('Gracias por tu compra');
  });

  it('greets the persisted customer name, folds in the optional folio and falls back to neutral copy', () => {
    const html = render();
    expect(html).toContain('Hola, Ada Lovelace.');
    expect(html).toContain('Folio: A-1001');
    const missing = render({
      summary: baseSummary({ customerName: null, folio: null }),
    });
    expect(missing).toContain('Hola.');
    expect(missing).not.toContain('Hola, ');
    expect(missing).not.toContain('Folio');
    const blank = render({
      summary: baseSummary({ customerName: '   ', folio: '   ' }),
    });
    expect(blank).not.toContain('Hola, ');
    expect(blank).not.toContain('Folio');
  });

  it('renders product, variant, quantity and the persisted NET line total', () => {
    const html = render();
    expect(html).toContain('Café molido');
    expect(html).toContain('500 g');
    expect(html).toContain('Taza cerámica');
    expect(html).toContain('>2</td>');
    expect(html).toContain('>$250.00</td>');
    expect(html).toContain('>$50.00</td>');
  });

  it('omits the variant line when variantName is null or blank', () => {
    const missing = render({
      summary: baseSummary({ items: [{ ...BASE_ITEM, variantName: null }] }),
    });
    expect(missing).toContain('Café molido');
    expect(missing).not.toContain('500 g');
    const blank = render({
      summary: baseSummary({ items: [{ ...BASE_ITEM, variantName: '   ' }] }),
    });
    expect(blank).not.toContain('500 g');
  });

  it('formats persisted cents with es-MX grouping, two decimals and sign', () => {
    expect(formatMxnCents(1234567)).toBe('$12,345.67');
    expect(formatMxnCents(100)).toBe('$1.00');
    expect(formatMxnCents(0)).toBe('$0.00');
    expect(formatMxnCents(-250)).toBe('-$2.50');
    expect(formatMxnCents(Number.NaN)).toBe('$0.00');
    // Grouping is pinned inside the markup too, not only in the helper: a
    // four-figure total must keep its thousands separator and the persisted
    // currency must label the amount column.
    const html = render({
      summary: baseSummary({ subtotalCents: 1234567, totalCents: 1234567 }),
    });
    expect(html).toContain('$12,345.67');
    expect(html).toContain('Importe (MXN)');
  });

  it('renders the persisted sale discount only when it is positive', () => {
    const withoutDiscount = render();
    expect(withoutDiscount).toContain('Subtotal');
    expect(withoutDiscount).not.toContain('Descuento');
    const withDiscount = render({
      summary: baseSummary({
        subtotalCents: 30000,
        discountCents: 5000,
        totalCents: 25000,
      }),
    });
    expect(withDiscount).toContain('Descuento');
    expect(withDiscount).toContain('-$50.00');
    expect(withDiscount).toContain('$300.00');
    expect(withDiscount).toContain('$250.00');
  });

  it('marks the Subtotal, Descuento and Total labels as row headers', () => {
    const html = render({
      summary: baseSummary({ discountCents: 5000, totalCents: 25000 }),
    });
    expect(html.match(/scope="row"/g)).toHaveLength(3);
    expect(html).toContain('scope="col"');
    const subtotal = html.match(/<th [^>]*>Subtotal<\/th>/)?.[0] ?? '';
    const total = html.match(/<th [^>]*>Total<\/th>/)?.[0] ?? '';
    expect(subtotal).toContain('scope="row"');
    // `<th>` defaults to bold, so the non-total labels must override it.
    expect(subtotal).toContain('font-weight:400');
    expect(total).toContain('font-weight:700');
  });

  it('renders a coupon line verbatim: net unit price, informational discount, no second subtraction', () => {
    const html = render({
      summary: baseSummary({
        subtotalCents: 15000,
        discountCents: 0,
        totalCents: 15000,
        items: [
          {
            ...BASE_ITEM,
            unitPriceCents: 5000,
            quantity: 2,
            lineTotalCents: 10000,
            discountAmountCents: 1000,
            discountTitle: 'Cupón BIENVENIDA',
            rewardKind: null,
          },
          BASE_ITEM_2,
        ],
      }),
    });
    // A free-form/coupon row keeps a NET unit price, so the line total is
    // already net and `discountAmountCents` is informational only.
    expect(html).toContain('>$100.00</td>');
    expect(html).toContain('Descuento: Cupón BIENVENIDA');
    expect(html).not.toContain('$90.00');
    expect(html).not.toContain('-$10.00');
  });

  it('renders the NET lineTotalCents verbatim for reward lines and never double counts', () => {
    const html = render({
      summary: baseSummary({
        subtotalCents: 11000,
        discountCents: 0,
        totalCents: 11000,
        items: [
          {
            ...BASE_ITEM,
            unitPriceCents: 5750,
            quantity: 2,
            lineTotalCents: 11000,
            discountAmountCents: 500,
            discountTitle: '2x1',
            rewardKind: 'buy_x_get_y',
          },
        ],
      }),
    });
    expect(html).toContain('$110.00');
    expect(html).toContain('Descuento: 2x1');
    // Gross (5,750 x 2) and the double-subtracted variant must not appear.
    expect(html).not.toContain('$115.00');
    expect(html).not.toContain('$105.00');
    expect(html).not.toContain('-$5.00');
  });

  it('escapes product, variant, discount, customer and tenant text', () => {
    const html = render({
      tenantName: 'Tienda & Cía <b>"X"</b>',
      summary: baseSummary({
        customerName: 'A <B> & C',
        items: [
          {
            ...BASE_ITEM,
            productName: 'Café <b>&"especial"',
            variantName: '<500 g>',
            discountAmountCents: 500,
            discountTitle: '<2x1>',
          },
        ],
      }),
    });
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&lt;2x1&gt;');
    expect(html).toContain('&lt;500 g&gt;');
  });

  it('never leaks an id, email, address, paid/debt claim, platform logo or platform marketing', () => {
    const html = render({ tenantName: 'HoundFe Demo' });
    expect(html).not.toContain('5f4d1f7a-1111-4c2b-9a10-abc123456789');
    expect(html).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/);
    expect(html).not.toMatch(/pagad|liquid|deuda|saldo/i);
    expect(html).not.toContain('Calle');
    expect(html).not.toContain('href=');
    // No platform image (a HoundFe logo must never be described as the
    // merchant via `alt`) and no B2B platform tagline in a receipt.
    expect(html).not.toContain('<img');
    expect(html).not.toContain('Gestión inteligente');
  });

  it('names the merchant only when the caller resolves it and stays neutral otherwise', () => {
    const withTenant = render({ tenantName: 'HoundFe Demo' });
    expect(withTenant).toContain('realizaste una compra en HoundFe Demo.');
    const without = render({ tenantName: null });
    expect(without).toContain('realizaste una compra.');
    expect(without).not.toContain('compra en');
    // No hardcoded platform name ever stands in for the merchant.
    expect(without).not.toContain('HoundFe');
    const blank = render({ tenantName: '   ' });
    expect(blank).not.toContain('compra en');
    expect(blank).not.toContain('HoundFe');
  });
});
