// Dev showcase › shipping address source status (Sucursal Centro): one
// seed-owned customer with three addresses and one confirmed delivery sale per
// address. Afterwards the customer edits one address (PATCH street) and deletes
// another, so the sale snapshots read as UNCHANGED, CHANGED and DELETED (see
// docs/sale-shipping-snapshot-reads.md).
//
// Everything goes through the real store API as manager@houndfe.com. Sales are
// found again by their Idempotency-Key (`showcase:sale:<slug>`), addresses by
// the sale's `shippingAddressId`, so a re-run creates and edits nothing once
// each sale shows its planned status.
'use strict';

const MANAGER = 'manager@houndfe.com';
// Stocked, lot-free catalog product (catalog.cjs) sold on every sale.
const PRODUCT = 'Arena Sanitaria Aglomerante 10 kg';
const CDMX = 'Ciudad de México';

const CUSTOMER = {
  firstName: 'Irene',
  lastName: 'Domínguez Ochoa',
  phone: '5512349901',
  email: 'irene.dominguez@correo.mx',
};

// One address per sale; `street` is the sale-time value kept by the snapshot.
const SALES = [
  {
    slug: 'domicilio-sin-cambios',
    status: 'UNCHANGED',
    address: {
      street: 'Calle Pilares',
      exteriorNumber: '415',
      zipCode: '03100',
      neighborhood: 'Del Valle Centro',
      municipality: 'Benito Juárez',
      city: CDMX,
      state: CDMX,
    },
  },
  {
    slug: 'domicilio-editado',
    status: 'CHANGED',
    editedStreet: 'Calle Uxmal',
    address: {
      street: 'Calle Xola',
      exteriorNumber: '1220',
      interiorNumber: '3',
      zipCode: '03020',
      neighborhood: 'Narvarte Poniente',
      municipality: 'Benito Juárez',
      city: CDMX,
      state: CDMX,
    },
  },
  {
    slug: 'domicilio-eliminado',
    status: 'DELETED',
    address: {
      street: 'Calle Dakota',
      exteriorNumber: '95',
      zipCode: '03810',
      neighborhood: 'Nápoles',
      municipality: 'Benito Juárez',
      city: CDMX,
      state: CDMX,
    },
  },
];

// ── Pure helpers ───────────────────────────────────────────────────────────

const idempotencyKey = (spec) => `showcase:sale:${spec.slug}`;

/** Addresses still to add: those of not-yet-charged sales whose street is missing. */
function planAddresses(specs, chargedSlugs, existing) {
  const streets = new Set(existing.map((address) => address.street));
  return specs
    .filter((spec) => !chargedSlugs.has(spec.slug))
    .filter((spec) => !streets.has(spec.address.street))
    .map((spec) => spec.address);
}

/**
 * The customer edit that moves a charged sale to its planned status, or null.
 * `sale` holds the snapshot street and source id; `live` is the source address
 * row (null once deleted). Statuses already reached (or past) are left alone.
 */
function planSourceStatus(spec, sale, live) {
  if (!sale.shippingAddressId || !live) return null;
  if (spec.status === 'DELETED') return { action: 'delete' };
  if (spec.status === 'CHANGED' && live.street === sale.shippingStreet) {
    return { action: 'patch', body: { street: spec.editedStreet } };
  }
  return null;
}

// ── Steps ──────────────────────────────────────────────────────────────────

async function call(ctx, token, method, route, { body, key } = {}) {
  const res = await ctx.api.http(method, route, {
    token,
    body,
    headers: key ? { 'idempotency-key': key } : {},
  });
  if (res.status < 200 || res.status >= 300) {
    const detail =
      typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    throw new Error(
      `${method} ${route} -> HTTP ${res.status} ${String(detail).slice(0, 300)}`,
    );
  }
  return res.body;
}

async function chargedSaleId(ctx, spec) {
  const row = await ctx.prisma.saleIdempotency.findFirst({
    where: {
      tenantId: ctx.centro.id,
      key: idempotencyKey(spec),
      saleId: { not: null },
    },
    select: { saleId: true },
  });
  return row?.saleId ?? null;
}

async function ensureCustomer(ctx, token, chargedSlugs) {
  const { prisma, centro } = ctx;
  const where = {
    tenantId: centro.id,
    firstName: CUSTOMER.firstName,
    lastName: CUSTOMER.lastName,
  };
  const load = () =>
    prisma.customer.findFirst({ where, include: { addresses: true } });
  let customer = await load();
  if (!customer) {
    await call(ctx, token, 'POST', '/customers', {
      body: {
        ...CUSTOMER,
        phoneCountryCode: '52',
        addresses: planAddresses(SALES, chargedSlugs, []),
      },
    });
    return { customer: await load(), addressesCreated: SALES.length };
  }
  const missing = planAddresses(SALES, chargedSlugs, customer.addresses);
  for (const address of missing) {
    await call(ctx, token, 'POST', `/customers/${customer.id}/addresses`, {
      body: address,
    });
  }
  if (missing.length > 0) customer = await load();
  return { customer, addressesCreated: missing.length };
}

async function chargeDeliverySale(ctx, token, spec, customer, product) {
  const address = customer.addresses.find(
    (row) => row.street === spec.address.street,
  );
  const draft = await call(ctx, token, 'POST', '/sales/drafts');
  try {
    const added = await call(
      ctx,
      token,
      'POST',
      `/sales/drafts/${draft.id}/items`,
      { body: { productId: product.id, quantity: 1 } },
    );
    await call(ctx, token, 'PUT', `/sales/drafts/${draft.id}/customer`, {
      body: { customerId: customer.id, shippingAddressId: address.id },
    });
    const charged = await call(
      ctx,
      token,
      'POST',
      `/sales/drafts/${draft.id}/charge`,
      {
        key: idempotencyKey(spec),
        body: { method: 'cash', amountCents: added.totalCents, delivery: true },
      },
    );
    return charged.saleId;
  } catch (error) {
    // An unfinished draft must not linger in the manager's open drafts.
    await ctx.prisma.sale.deleteMany({
      where: { id: draft.id, tenantId: ctx.centro.id, status: 'DRAFT' },
    });
    throw error;
  }
}

async function run(ctx) {
  const { api, prisma, centro } = ctx;
  const token = await api.login(MANAGER, centro.id);
  const product = await prisma.product.findFirst({
    where: { tenantId: centro.id, name: PRODUCT },
    select: { id: true },
  });
  if (!product) throw new Error(`product missing (run catalog): ${PRODUCT}`);

  const saleIds = new Map();
  for (const spec of SALES) {
    const id = await chargedSaleId(ctx, spec);
    if (id) saleIds.set(spec.slug, id);
  }
  const { customer, addressesCreated } = await ensureCustomer(
    ctx,
    token,
    new Set(saleIds.keys()),
  );

  const summary = { addressesCreated, salesCreated: 0, edits: 0, sales: {} };
  for (const spec of SALES) {
    if (!saleIds.has(spec.slug)) {
      saleIds.set(
        spec.slug,
        await chargeDeliverySale(ctx, token, spec, customer, product),
      );
      summary.salesCreated += 1;
    }
    const sale = await prisma.sale.findFirstOrThrow({
      where: { id: saleIds.get(spec.slug), tenantId: centro.id },
      select: { folio: true, shippingStreet: true, shippingAddressId: true },
    });
    const live = sale.shippingAddressId
      ? await prisma.customerAddress.findFirst({
          where: { id: sale.shippingAddressId, tenantId: centro.id },
          select: { street: true },
        })
      : null;
    const step = planSourceStatus(spec, sale, live);
    if (step) {
      const route = `/customers/${customer.id}/addresses/${sale.shippingAddressId}`;
      if (step.action === 'delete') {
        await call(ctx, token, 'DELETE', route);
      } else {
        await call(ctx, token, 'PATCH', route, { body: step.body });
      }
      summary.edits += 1;
    }
    summary.sales[sale.folio ?? saleIds.get(spec.slug)] = spec.status;
  }
  return summary;
}

module.exports = {
  name: 'address-status',
  run,
  CUSTOMER,
  SALES,
  PRODUCT,
  idempotencyKey,
  planAddresses,
  planSourceStatus,
};
