// Dev showcase · ops: human decisions, delivery routes, procurement, HR, admin
// and system settings. Idempotent: every demo entity is matched by a readable
// natural key (note, name, CLABE, employee + dates) or a deterministic
// Idempotency-Key, so a re-run creates nothing new. Stateful flows go through
// the real HTTP API; Prisma is used only where no endpoint exists.
// Dev only: set SHOWCASE_OPS_ONLY=hr,admin to run a subset while iterating.
'use strict';

const crypto = require('node:crypto');

const MANAGER = 'manager@houndfe.com';
const DRIVER = 'repartidor@houndfe.com';
const DRIVER_NAME = 'Luis Hernández';
const RESTOCK_SOURCE = 'houndfe-chatbot';
const DAY_MS = 86_400_000;

const ROLE_DESCRIPTIONS = {
  Manager: 'Gerente: acceso completo a la sucursal',
  Cashier: 'Cajero: ventas, cobros y caja',
  repartidor: 'Repartidor: rutas y entregas asignadas',
};

// The base seed gives Manager no purchasing, routing or settings powers; a
// gerente would have them, and the screens below need a real actor.
const MANAGER_GRANTS = {
  ProcurementSupplier: ['create', 'read', 'update', 'delete'],
  ProcurementPurchaseOrder: ['create', 'read', 'update', 'delete'],
  ProcurementOrderConfirmation: ['create'],
  ProcurementOrderCancellation: ['create'],
  DeliveryRoute: ['create', 'read', 'update', 'delete'],
  PaymentMethod: ['create', 'read', 'update', 'delete'],
  PaymentDetail: ['create', 'read', 'update', 'delete'],
  NotificationConfig: ['read', 'update'],
  TenantCatalogSettings: ['read', 'update'],
  HumanDecision: ['read', 'update'],
};

const DELIVERY_SALES = [
  { key: 'entrega-narvarte', customer: 0, items: [[0, 1]] },
  { key: 'entrega-del-valle', customer: 1, items: [[1, 2]] },
  {
    key: 'entrega-roma-norte',
    customer: 2,
    items: [
      [0, 1],
      [1, 1],
    ],
  },
  { key: 'entrega-condesa', customer: 3, items: [[1, 2]] },
  { key: 'entrega-napoles', customer: 4, items: [[0, 2]] },
  { key: 'entrega-escandon', customer: 5, items: [[1, 1]] },
  { key: 'entrega-coyoacan', customer: 6, items: [[0, 1]] },
  { key: 'entrega-mixcoac', customer: 7, items: [[1, 1]] },
  { key: 'entrega-portales', customer: 0, items: [[0, 3]] },
  { key: 'entrega-pendiente-1', customer: 3, items: [[1, 1]] },
  { key: 'entrega-pendiente-2', customer: 5, items: [[0, 1]] },
];

const ROUTES = [
  {
    status: 'DRAFT',
    notes: 'Ruta de la tarde: Narvarte y Del Valle',
    sales: [0, 1],
  },
  {
    status: 'ACTIVE',
    notes: 'Ruta matutina: Roma, Condesa, Nápoles y Escandón',
    sales: [2, 3, 4, 5],
  },
  {
    status: 'COMPLETED',
    notes: 'Ruta de ayer: Coyoacán y Mixcoac',
    sales: [6, 7],
  },
  {
    status: 'CANCELLED',
    notes: 'Ruta cancelada: la camioneta entró a taller',
    sales: [8],
  },
];

const SUPPLIERS = [
  {
    name: 'Distribuidora Canina del Bajío',
    terms: 'Crédito a 30 días. Entrega en 3 días hábiles.',
  },
  {
    name: 'Alimentos Premium para Mascotas Monterrey',
    terms: 'Pago de contado con 3% de descuento. Envío sin costo desde $5,000.',
  },
  {
    name: 'Accesorios y Juguetes Patitas',
    terms: 'Crédito a 15 días. Pedido mínimo de $2,500.',
  },
  {
    name: 'Farmacia Veterinaria Zapopan',
    terms: 'Contado. Entrega los martes y viernes.',
  },
  { name: 'Acuarios y Peceras del Norte', terms: null, archived: true },
];

const HR_DOCUMENTS = [
  {
    employee: 'EMP-010',
    category: 'CERTIFICATE',
    title: 'Constancia de manejo de efectivo (vencida)',
    days: -12,
  },
  {
    employee: 'EMP-002',
    category: 'ID_DOCUMENT',
    title: 'Credencial INE vencida',
    days: -40,
  },
  {
    employee: 'EMP-007',
    category: 'MEDICAL',
    title: 'Examen médico anual vencido',
    days: -3,
  },
  {
    employee: 'EMP-001',
    category: 'CERTIFICATE',
    title: 'Constancia de protección civil por vencer',
    days: 5,
  },
  {
    employee: 'EMP-016',
    category: 'CONTRACT',
    title: 'Convenio de prácticas profesionales por vencer',
    days: 9,
  },
  {
    employee: 'EMP-005',
    category: 'ID_DOCUMENT',
    title: 'Pasaporte por vencer',
    days: 14,
  },
  {
    employee: 'EMP-011',
    category: 'MEDICAL',
    title: 'Certificado médico por vencer',
    days: 21,
  },
  {
    employee: 'EMP-013',
    category: 'CONTRACT',
    title: 'Contrato temporal por vencer',
    days: 28,
  },
  {
    employee: 'EMP-003',
    category: 'CERTIFICATE',
    title: 'Certificación de bienestar animal vigente',
    days: 210,
  },
];

const HR_TIME_OFF = [
  {
    employee: 'EMP-011',
    type: 'PERSONAL',
    start: 2,
    length: 1,
    reason: 'Cita en el IMSS por la mañana',
  },
  {
    employee: 'EMP-014',
    type: 'PERSONAL',
    start: 6,
    length: 1,
    reason: 'Trámite de cambio de domicilio',
  },
  {
    employee: 'EMP-012',
    type: 'VACATION',
    start: 9,
    length: 5,
    reason: 'Vacaciones familiares en Valle de Bravo',
  },
  {
    employee: 'EMP-016',
    type: 'VACATION',
    start: 16,
    length: 3,
    reason: 'Viaje a Guadalajara por una boda',
  },
  {
    employee: 'EMP-004',
    type: 'UNPAID',
    start: 12,
    length: 2,
    reason: 'Examen de la maestría',
  },
  {
    employee: 'EMP-010',
    type: 'VACATION',
    start: 20,
    length: 6,
    reason: 'Descanso de fin de año',
    decision: 'APPROVED',
    reviewerNotes: 'Aprobado; hay cobertura en caja.',
  },
  {
    employee: 'EMP-013',
    type: 'PERSONAL',
    start: 25,
    length: 2,
    reason: 'Mudanza',
    decision: 'REJECTED',
    reviewerNotes: 'Coincide con el inventario de cierre de mes.',
  },
];

const PAYMENT_METHODS = [
  {
    name: 'Efectivo en mostrador',
    category: 'cash',
    subtitle: 'Pagos en pesos mexicanos',
  },
  {
    name: 'Tarjeta de débito y crédito',
    category: 'card_debit',
    subtitle: 'Terminal Clip en caja',
  },
  {
    name: 'Transferencia SPEI',
    category: 'transfer',
    subtitle: 'Depósito a la cuenta del negocio',
  },
  {
    name: 'Vales de despensa',
    category: 'cash',
    subtitle: 'Se dejó de aceptar en octubre',
    inactive: true,
  },
];

const BANK_ACCOUNTS = [
  {
    bankName: 'BBVA México',
    beneficiary: 'Mascotas Houndfe S.A. de C.V.',
    clabe: '012180001234567891',
    accountNumber: '0123456789',
  },
  {
    bankName: 'Banorte',
    beneficiary: 'Mascotas Houndfe S.A. de C.V.',
    clabe: '072180009876543219',
    accountNumber: '1098765432',
  },
  {
    bankName: 'Santander',
    beneficiary: 'Mascotas Houndfe S.A. de C.V.',
    clabe: '014180005551234567',
    accountNumber: '65501234567',
    inactive: true,
  },
];

// ── helpers ────────────────────────────────────────────────────────────────

/** Deterministic RFC 4122 v5-shaped UUID, so replays reuse the same identity. */
function stableUuid(seed) {
  const hash = crypto
    .createHash('sha1')
    .update(`houndfe-showcase:${seed}`)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

const slugify = (text) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Calendar day (YYYY-MM-DD) in the business timezone, `days` from `base`. */
function ymd(base, days, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(base.getTime() + days * DAY_MS));
}

const money = (value) => value.toFixed(2);

const dateOnly = (text) => new Date(`${text}T00:00:00.000Z`);

function decodeClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  } catch {
    return {};
  }
}

// ── run ────────────────────────────────────────────────────────────────────

async function run(ctx) {
  const { prisma, centro, api, today, tz } = ctx;
  const only = process.env.SHOWCASE_OPS_ONLY
    ? new Set(process.env.SHOWCASE_OPS_ONLY.split(','))
    : null;
  const summary = {};
  const unsupported = [];

  /** Bearer token for a base-seed user, switched to Sucursal Centro if needed. */
  const tokens = new Map();
  async function tokenFor(email) {
    if (tokens.has(email)) return tokens.get(email);
    let token = await api.login(email);
    if (decodeClaims(token).tenantId == null) {
      const switched = await api.http('POST', '/auth/switch-tenant', {
        token,
        body: { tenantId: centro.id },
      });
      if (switched.status !== 200) {
        throw new Error(`switch-tenant ${email}: HTTP ${switched.status}`);
      }
      token = switched.body.accessToken;
    }
    tokens.set(email, token);
    return token;
  }

  /** HTTP call that fails loudly (never echoing request bodies or tokens). */
  async function call(method, route, { actor = MANAGER, body, key } = {}) {
    const token = await tokenFor(actor);
    const response = await api.http(method, route, {
      token,
      body,
      headers: key ? { 'idempotency-key': key } : {},
    });
    if (response.status < 200 || response.status >= 300) {
      const detail =
        typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body);
      throw new Error(
        `${method} ${route} -> HTTP ${response.status} ${String(detail).slice(0, 300)}`,
      );
    }
    return response.body;
  }

  const section = async (name, fn) => {
    if (only && !only.has(name)) return;
    const started = Date.now();
    summary[name] = await fn();
    console.log(
      `  · ops/${name} (${Math.round((Date.now() - started) / 1000)} s)`,
    );
  };

  const manager = await prisma.user.findUnique({ where: { email: MANAGER } });
  if (!manager) {
    throw new Error(
      `Base seed missing user ${MANAGER}: run \`pnpm seed\` first`,
    );
  }
  const driver = await prisma.user.findUnique({ where: { email: DRIVER } });

  // Products used as realistic references (decisions, purchases, deliveries).
  const catalogProducts = await prisma.product.findMany({
    where: { tenantId: centro.id, type: 'PRODUCT', sellInPos: true },
    orderBy: { name: 'asc' },
    select: {
      id: true,
      name: true,
      sku: true,
      unit: true,
      quantity: true,
      minQuantity: true,
      useStock: true,
      hasVariants: true,
      useLotsAndExpirations: true,
      priceLists: { select: { priceCents: true }, take: 1 },
    },
  });
  const plainProducts = catalogProducts.filter(
    (p) => !p.hasVariants && !/prueba|probe/i.test(p.name),
  );

  // ── Identity: manager grants, role texts, driver name ────────────────────
  await section('identity', async () => {
    const result = { grants: 0, rolesDescribed: 0, driver: null };
    const role = await prisma.role.findFirst({
      where: { tenantId: centro.id, name: 'Manager' },
    });
    if (role) {
      for (const [subject, actions] of Object.entries(MANAGER_GRANTS)) {
        for (const action of actions) {
          const permission = await prisma.permission.findUnique({
            where: { subject_action: { subject, action } },
          });
          if (!permission) continue;
          await prisma.rolePermission.upsert({
            where: {
              roleId_permissionId: {
                roleId: role.id,
                permissionId: permission.id,
              },
            },
            update: {},
            create: { roleId: role.id, permissionId: permission.id },
          });
          result.grants += 1;
        }
      }
    }
    for (const [name, description] of Object.entries(ROLE_DESCRIPTIONS)) {
      const { count } = await prisma.role.updateMany({
        where: { tenantId: centro.id, name },
        data: { description },
      });
      result.rolesDescribed += count;
    }
    if (driver) {
      await prisma.user.update({
        where: { id: driver.id },
        data: { name: DRIVER_NAME },
      });
      result.driver = DRIVER_NAME;
    }
    return result;
  });

  // ── Human decisions ──────────────────────────────────────────────────────
  await section('humanDecisions', async () => {
    if (plainProducts.length < 6) {
      unsupported.push(
        'Decisiones pendientes: faltan productos en el catálogo',
      );
      return { skipped: 'catalog has fewer than 6 products' };
    }
    const sku = (p) => p.sku ?? null;
    // The bot writes the intake row; there is no staff endpoint for it, so the
    // PENDING rows are inserted exactly as the intake adapter would.
    const specs = [
      {
        key: 'reposicion-pendiente-1',
        type: 'RESTOCK',
        product: plainProducts[0],
        requested: 12,
        hoursAgo: 3,
      },
      {
        key: 'reposicion-pendiente-2',
        type: 'RESTOCK',
        product: plainProducts[1],
        requested: 6,
        hoursAgo: 30,
      },
      {
        key: 'caducidad-pendiente-1',
        type: 'EXPIRATION',
        product: plainProducts[2],
        hoursAgo: 8,
      },
      {
        key: 'reposicion-aprobada',
        type: 'RESTOCK',
        product: plainProducts[3],
        requested: 20,
        hoursAgo: 52,
        resolve: { action: 'PROVIDE_RESTOCK_ESTIMATE', restockDays: 5 },
      },
      {
        key: 'reposicion-rechazada',
        type: 'RESTOCK',
        product: plainProducts[4],
        requested: 8,
        hoursAgo: 76,
        resolve: { action: 'REPORT_RESTOCK_ESTIMATE_UNAVAILABLE' },
      },
      {
        key: 'caducidad-aprobada',
        type: 'EXPIRATION',
        product: plainProducts[5],
        hoursAgo: 40,
        resolve: {
          action: 'PROVIDE_EXPIRATION_TEXT',
          expirationText: `Caduca el ${ymd(today, 45, tz)} (lote impreso en el empaque)`,
        },
      },
      {
        key: 'caducidad-rechazada',
        type: 'EXPIRATION',
        product: plainProducts[6] ?? plainProducts[0],
        hoursAgo: 100,
        resolve: { action: 'REPORT_EXPIRATION_UNAVAILABLE' },
      },
    ];
    const counts = { PENDING: 0, RESOLVED: 0 };
    for (const spec of specs) {
      const sourceRequestId = stableUuid(`human-decision:${spec.key}`);
      let row = await prisma.humanDecision.findFirst({
        where: {
          tenantId: centro.id,
          source: RESTOCK_SOURCE,
          sourceRequestId,
        },
      });
      if (!row) {
        const createdAt = new Date(today.getTime() - spec.hoursAgo * 3_600_000);
        const isRestock = spec.type === 'RESTOCK';
        row = await prisma.humanDecision.create({
          data: {
            tenantId: centro.id,
            source: RESTOCK_SOURCE,
            sourceRequestId,
            type: spec.type,
            canonicalRequestHash: crypto
              .createHash('sha256')
              .update(`showcase:${spec.key}`)
              .digest('hex'),
            submittedCredentialId: stableUuid('human-decision:credential'),
            branchId: centro.id,
            branchName: centro.name,
            productId: spec.product.id,
            productName: spec.product.name,
            sku: isRestock ? sku(spec.product) : null,
            requestedQuantity: isRestock ? spec.requested : null,
            observedStockAtRequest: isRestock ? spec.product.quantity : null,
            stockObservedAt: isRestock ? createdAt : null,
            productUnit: isRestock ? null : spec.product.unit,
            createdAt,
          },
        });
      }
      if (spec.resolve && row.status === 'PENDING') {
        row = await resolveDecision(row, spec);
      }
      counts[row.status] += 1;
    }
    return counts;
  });

  /** Staff resolve through the real endpoint (audited reviewer + version). */
  async function resolveDecision(row, spec) {
    await call('POST', `/human-decisions/${row.id}/resolve`, {
      body: {
        ...spec.resolve,
        expectedVersion: row.version,
        resolutionRequestId: stableUuid(`human-decision-resolve:${spec.key}`),
      },
    });
    return prisma.humanDecision.findUniqueOrThrow({ where: { id: row.id } });
  }

  // ── Delivery routes ──────────────────────────────────────────────────────
  await section('deliveryRoutes', async () => {
    if (!driver) {
      unsupported.push(`Rutas de entrega: falta el usuario ${DRIVER}`);
      return { skipped: `${DRIVER} not found` };
    }
    const stock = plainProducts.filter(
      (p) =>
        p.useStock &&
        !p.useLotsAndExpirations &&
        p.quantity >= 12 &&
        p.priceLists.length > 0,
    );
    if (stock.length < 2) {
      unsupported.push('Rutas de entrega: faltan productos con existencias');
      return { skipped: 'no stocked products with a price' };
    }
    const customers = await ensureDeliveryCustomers();
    const sales = [];
    for (const [index, spec] of DELIVERY_SALES.entries()) {
      const customer = customers[spec.customer];
      const items = spec.items.map(([offset, quantity]) => ({
        product: stock[(index + offset) % stock.length],
        quantity,
      }));
      sales.push(await ensureDeliverySale(spec.key, customer, items));
    }
    const result = { sales: sales.length, routes: {} };
    for (const spec of ROUTES) {
      result.routes[spec.status] = await ensureRoute(
        spec,
        spec.sales.map((i) => sales[i]),
      );
    }
    return result;
  });

  async function ensureDeliveryCustomers() {
    const out = [];
    for (const spec of DELIVERY_CUSTOMERS) {
      let customer = await prisma.customer.findFirst({
        where: {
          tenantId: centro.id,
          firstName: spec.firstName,
          lastName: spec.lastName,
        },
        include: { addresses: true },
      });
      if (!customer) {
        const { address, ...fields } = spec;
        await call('POST', '/customers', {
          body: {
            ...fields,
            phoneCountryCode: '+52',
            comments: 'Cliente de entregas a domicilio',
            addresses: [address],
          },
        });
        customer = await prisma.customer.findFirstOrThrow({
          where: {
            tenantId: centro.id,
            firstName: spec.firstName,
            lastName: spec.lastName,
          },
          include: { addresses: true },
        });
      }
      out.push({ id: customer.id, addressId: customer.addresses[0].id });
    }
    return out;
  }

  /** Charged, delivery-pending sale; the Idempotency-Key is its natural key. */
  async function ensureDeliverySale(slug, customer, items) {
    const key = `showcase-ops:${slug}`;
    const known = await prisma.saleIdempotency.findFirst({
      where: { tenantId: centro.id, key, saleId: { not: null } },
    });
    if (known) return known.saleId;
    const draft = await call('POST', '/sales/drafts');
    let total = 0;
    for (const { product, quantity } of items) {
      const added = await call('POST', `/sales/drafts/${draft.id}/items`, {
        body: { productId: product.id, quantity },
      });
      total = added.totalCents;
    }
    await call('PUT', `/sales/drafts/${draft.id}/customer`, {
      body: { customerId: customer.id, shippingAddressId: customer.addressId },
    });
    const charged = await call('POST', `/sales/drafts/${draft.id}/charge`, {
      key,
      body: { method: 'cash', amountCents: total, delivery: true },
    });
    return charged.saleId;
  }

  async function ensureRoute(spec, saleIds) {
    const where = { tenantId: centro.id, notes: spec.notes };
    let route = await prisma.deliveryRoute.findFirst({
      where,
      include: { stops: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!route) {
      const created = await call('POST', '/delivery-routes', {
        body: { saleIds, driverUserId: driver.id, notes: spec.notes },
      });
      route = { id: created.id, status: created.status, stops: [] };
    }
    const reload = () =>
      prisma.deliveryRoute.findUniqueOrThrow({
        where: { id: route.id },
        include: { stops: { orderBy: { sortOrder: 'asc' } } },
      });
    route = await reload();
    const act = (suffix) =>
      call('POST', `/delivery-routes/${route.id}/${suffix}`);

    if (spec.status === 'CANCELLED' && route.status === 'DRAFT') {
      await act('cancel');
      await prisma.deliveryRoute.update({
        where: { id: route.id },
        data: {
          createdAt: new Date(today.getTime() - 3 * DAY_MS),
          cancelledAt: new Date(today.getTime() - 2 * DAY_MS),
        },
      });
    }

    if (
      (spec.status === 'ACTIVE' || spec.status === 'COMPLETED') &&
      route.status === 'DRAFT'
    ) {
      await act('start');
      route = await reload();
    }

    if (spec.status === 'COMPLETED' && route.status === 'ACTIVE') {
      for (const stop of route.stops) {
        await act(`stops/${stop.id}/check-in`);
      }
      route = await reload();
      // Yesterday's run: shift the stamps the API wrote "now".
      const start = today.getTime() - DAY_MS - 3 * 3_600_000;
      await prisma.deliveryRoute.update({
        where: { id: route.id },
        data: {
          createdAt: new Date(start - 12 * 3_600_000),
          startedAt: new Date(start),
          completedAt: new Date(start + 95 * 60_000),
        },
      });
      for (const [i, stop] of route.stops.entries()) {
        const at = new Date(start + (30 + i * 55) * 60_000);
        await prisma.deliveryRouteStop.update({
          where: { id: stop.id },
          data: { checkedInAt: at, completedAt: at },
        });
      }
    }

    if (spec.status === 'ACTIVE' && route.status === 'ACTIVE') {
      const [first, skipped] = route.stops;
      if (first.status === 'PENDING') await act(`stops/${first.id}/check-in`);
      if (skipped.status === 'PENDING') {
        // SKIPPED is a persisted enum value, but no API path emits it yet.
        await prisma.deliveryRouteStop.update({
          where: { id: skipped.id },
          data: {
            status: 'SKIPPED',
            skippedReason: 'Nadie abrió en el domicilio; se reprograma',
          },
        });
      }
      const startedAt = new Date(today.getTime() - 40 * 60_000);
      await prisma.deliveryRoute.update({
        where: { id: route.id },
        data: { startedAt },
      });
      await prisma.deliveryRouteStop.update({
        where: { id: first.id },
        data: {
          checkedInAt: new Date(startedAt.getTime() + 15 * 60_000),
          completedAt: new Date(startedAt.getTime() + 15 * 60_000),
        },
      });
    }
    route = await reload();
    return {
      status: route.status,
      stops: route.stops.map((s) => s.status),
    };
  }

  // ── Procurement ──────────────────────────────────────────────────────────
  await section('procurement', async () => {
    if (plainProducts.length < 4) {
      unsupported.push('Compras: faltan productos en el catálogo');
      return { skipped: 'catalog has fewer than 4 products' };
    }
    const suppliers = await ensureSuppliers();
    const orders = await ensureOrders(suppliers);
    return { suppliers: Object.keys(suppliers).length, orders };
  });

  async function listSuppliers() {
    const page = await call(
      'GET',
      '/procurement/suppliers?status=ALL&limit=100',
    );
    return page.items;
  }

  async function ensureSuppliers() {
    const known = await listSuppliers();
    const out = {};
    for (const spec of SUPPLIERS) {
      let supplier = known.find((s) => s.displayName === spec.name);
      if (!supplier) {
        // Created ACTIVE so a draft can still be saved against it; the
        // archived one is archived after its order exists (see ensureOrders).
        supplier = await call('POST', '/procurement/suppliers', {
          key: `showcase-ops:supplier:${slugify(spec.name)}`,
          body: {
            displayName: spec.name,
            termsText: spec.terms,
            status: 'ACTIVE',
          },
        });
      }
      out[spec.name] = supplier;
    }
    return out;
  }

  async function ensureOrders(suppliers) {
    const [p1, p2, p3, p4] = plainProducts;
    const cost = (product, amount) => ({
      amount: money(amount),
      currency: 'MXN',
      unit: product.unit,
      taxBasis: 'EXCLUDES_TAX',
    });
    const line = (slug, product, quantity, amount) => ({
      lineId: stableUuid(`po-line:${slug}`),
      productId: product ? product.id : null,
      variantId: null,
      orderedQuantity: quantity === null ? null : String(quantity),
      informedUnitCost:
        amount === null || product === null ? null : cost(product, amount),
    });
    const nombre = (n) => SUPPLIERS[n].name;
    const specs = [
      {
        slug: 'reposicion-croquetas-premium',
        supplier: nombre(1),
        note: 'Reposición mensual de croquetas premium',
        detail: 'Bodega principal, andén 2',
        lines: [line('rcp-1', p1, 12, 780.5), line('rcp-2', p2, 8, 412)],
      },
      {
        slug: 'accesorios-cachorro',
        supplier: nombre(2),
        note: 'Surtido de accesorios para cachorro',
        detail: 'Mostrador de accesorios',
        lines: [line('acc-1', p3, 24, 85), line('acc-2', p4, 30, 45)],
      },
      {
        slug: 'sin-costos',
        supplier: nombre(1),
        note: 'Pedido de alimento premium sin costos capturados',
        detail: null,
        lines: [line('sc-1', p1, 6, null), line('sc-2', p2, 10, null)],
      },
      {
        slug: 'sin-cantidad',
        supplier: nombre(3),
        note: 'Antiparasitarios: falta confirmar cantidades',
        detail: 'Bodega de refrigerados',
        lines: [line('sq-1', p3, null, 62.4), line('sq-2', p4, null, 98)],
      },
      {
        slug: 'producto-por-definir',
        supplier: nombre(0),
        note: 'Pedido con un producto por definir',
        detail: 'Bodega principal, andén 3',
        lines: [line('pd-1', null, 5, null), line('pd-2', p1, 4, 790)],
      },
      {
        slug: 'feria-adopcion',
        supplier: null,
        note: 'Pedido incompleto para la feria de adopción',
        detail: 'Mostrador de accesorios',
        lines: [
          line('fa-1', null, 10, 55),
          line('fa-2', p2, 6, null),
          line('fa-3', p3, null, 70),
        ],
      },
      {
        slug: 'proveedor-archivado',
        supplier: nombre(4),
        note: 'Pedido guardado antes de archivar al proveedor',
        detail: 'Bodega de acuarios',
        lines: [line('pa-1', p4, 3, 540)],
        archiveSupplier: true,
      },
      {
        slug: 'confirmada-croquetas',
        supplier: nombre(1),
        note: 'Orden confirmada: croquetas para la sucursal',
        detail: 'Bodega principal, andén 1',
        lines: [line('cc-1', p1, 20, 795)],
        finish: 'CONFIRMED',
      },
      {
        slug: 'confirmada-juguetes',
        supplier: nombre(2),
        note: 'Orden confirmada: juguetes de temporada',
        detail: 'Mostrador de accesorios',
        lines: [line('cj-1', p3, 48, 39.9), line('cj-2', p4, 18, 120)],
        finish: 'CONFIRMED',
      },
      {
        slug: 'cancelada-sin-existencias',
        supplier: nombre(3),
        note: 'Orden cancelada: el proveedor no tenía existencias',
        detail: 'Bodega de refrigerados',
        lines: [line('cs-1', p2, 5, 780.5)],
        finish: 'CANCELLED',
        confirmFirst: true,
      },
      {
        slug: 'cancelada-borrador',
        supplier: nombre(2),
        note: 'Pedido cancelado antes de confirmar: cambio de proveedor',
        detail: null,
        lines: [line('cb-1', p4, 15, 41)],
        finish: 'CANCELLED',
      },
    ];

    const existing = new Map();
    let cursor = null;
    do {
      const page = await call(
        'GET',
        `/procurement/purchase-orders?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      for (const item of page.items) existing.set(item.note, item);
      cursor = page.nextCursor;
    } while (cursor);

    const result = {};
    for (const spec of specs) {
      let order = existing.get(spec.note);
      const supplier = spec.supplier ? suppliers[spec.supplier] : null;
      if (!order) {
        const body = {
          supplierId: supplier ? supplier.id : null,
          note: spec.note,
          location: { detail: spec.detail },
          lines: spec.lines,
        };
        const restore = supplier && supplier.status === 'ARCHIVED';
        if (restore) await setSupplierStatus(supplier, 'ACTIVE');
        order = await call('POST', '/procurement/purchase-orders', {
          key: `showcase-ops:po:${spec.slug}`,
          body,
        });
        if (restore) await setSupplierStatus(supplier, 'ARCHIVED');
      }
      if (spec.archiveSupplier && supplier.status !== 'ARCHIVED') {
        await setSupplierStatus(supplier, 'ARCHIVED');
      }
      if (spec.finish) order = await finishOrder(order, spec);
      result[spec.note] = order.status;
    }
    const final = await call('GET', '/procurement/purchase-orders?limit=100');
    const summaries = {};
    for (const item of final.items) {
      if (specs.some((s) => s.note === item.note)) {
        summaries[item.note] = {
          status: item.status,
          avisos: item.checklistItemCount,
          ...item.issueSummary,
        };
      }
    }
    return summaries;
  }

  async function setSupplierStatus(supplier, status) {
    const current = await call('GET', `/procurement/suppliers/${supplier.id}`);
    if (current.status === status) return;
    const updated = await call(
      'PATCH',
      `/procurement/suppliers/${supplier.id}`,
      {
        key: `showcase-ops:supplier-status:${supplier.id}:${status}:v${current.version}`,
        body: { expectedVersion: current.version, changes: { status } },
      },
    );
    supplier.status = updated.status;
    supplier.version = updated.version;
  }

  async function finishOrder(order, spec) {
    const base = `/procurement/purchase-orders/${order.id}`;
    let detail = await call('GET', base);
    if (spec.finish === 'CONFIRMED' || spec.confirmFirst) {
      if (detail.status === 'DRAFT') {
        detail = await call('POST', `${base}/confirm`, {
          key: `showcase-ops:po-confirm:${spec.slug}`,
          body: {
            expectedVersion: detail.version,
            expectedSupplierVersion: detail.supplierCurrentVersion,
            expectedReferenceToken: detail.referenceToken,
          },
        });
      }
    }
    if (spec.finish === 'CANCELLED' && detail.status !== 'CANCELLED') {
      detail = await call('POST', `${base}/cancel`, {
        key: `showcase-ops:po-cancel:${spec.slug}`,
        body: { expectedVersion: detail.version },
      });
    }
    return detail;
  }

  // ── HR ───────────────────────────────────────────────────────────────────
  await section('hr', async () => {
    const employees = await prisma.employee.findMany({
      where: { tenantId: centro.id },
      select: { id: true, employeeNumber: true, status: true, firstName: true },
    });
    const byNumber = new Map(employees.map((e) => [e.employeeNumber, e]));
    const statuses = employees.reduce((acc, e) => {
      acc[e.status] = (acc[e.status] ?? 0) + 1;
      return acc;
    }, {});
    for (const wanted of ['ACTIVE', 'ON_LEAVE', 'TERMINATED']) {
      if (!statuses[wanted]) {
        unsupported.push(`RR.HH.: no hay colaboradores en estado ${wanted}`);
      }
    }

    // Documents: dates relative to today (expired and expiring soon).
    let documents = 0;
    for (const spec of HR_DOCUMENTS) {
      const employee = byNumber.get(spec.employee);
      if (!employee) continue;
      const notes = spec.title;
      const exists = await prisma.employeeDocument.findFirst({
        where: {
          tenantId: centro.id,
          employeeId: employee.id,
          category: spec.category,
          notes,
        },
      });
      const expiresAt = dateOnly(ymd(today, spec.days, tz));
      if (exists) {
        if (exists.expiresAt?.getTime() !== expiresAt.getTime()) {
          await prisma.employeeDocument.update({
            where: { id: exists.id },
            data: { expiresAt },
          });
        }
        documents += 1;
        continue;
      }
      const storageKey = `demo/${centro.slug}/employees/${spec.employee}/${slugify(spec.title)}.pdf`;
      const file = await prisma.fileObject.upsert({
        where: { storageKey },
        update: {},
        create: {
          storageKey,
          url: `https://demo-assets.houndfe.local/${storageKey}`,
          mimeType: 'application/pdf',
          sizeBytes: 184_000,
          ownerType: 'EmployeeDocument',
          ownerId: employee.id,
          uploadedBy: manager.id,
          tenantId: centro.id,
        },
      });
      await prisma.employeeDocument.create({
        data: {
          employeeId: employee.id,
          fileId: file.id,
          category: spec.category,
          expiresAt,
          notes,
          uploadedByUserId: manager.id,
          tenantId: centro.id,
        },
      });
      documents += 1;
    }

    // Time off: through the API so the request flow (and its outbox) is real.
    const timeOff = { PENDING: 0, APPROVED: 0, REJECTED: 0 };
    for (const spec of HR_TIME_OFF) {
      const employee = byNumber.get(spec.employee);
      if (!employee) continue;
      const startDate = ymd(today, spec.start, tz);
      const endDate = ymd(today, spec.start + spec.length - 1, tz);
      let row = await prisma.employeeTimeOff.findFirst({
        where: {
          tenantId: centro.id,
          employeeId: employee.id,
          type: spec.type,
          startDate: dateOnly(startDate),
          endDate: dateOnly(endDate),
        },
      });
      if (!row) {
        const created = await call(
          'POST',
          `/admin/employees/${employee.id}/time-off`,
          {
            body: {
              type: spec.type,
              startDate,
              endDate,
              reason: spec.reason,
            },
          },
        );
        row = { id: created.id, status: created.status };
      }
      if (spec.decision && row.status === 'PENDING') {
        await call(
          'POST',
          `/admin/employees/${employee.id}/time-off/${row.id}/review`,
          {
            body: {
              decision: spec.decision,
              reviewerNotes: spec.reviewerNotes,
            },
          },
        );
        row = { ...row, status: spec.decision };
      }
      timeOff[row.status] = (timeOff[row.status] ?? 0) + 1;
    }
    return { employeesByStatus: statuses, documents, timeOff };
  });

  // ── Admin: payment methods and bank accounts ─────────────────────────────
  await section('admin', async () => {
    const methods = await call('GET', '/admin/payment-methods');
    const methodRows = Array.isArray(methods) ? methods : (methods.items ?? []);
    for (const spec of PAYMENT_METHODS) {
      let row = methodRows.find((m) => m.name === spec.name);
      if (!row) {
        row = await call('POST', '/admin/payment-methods', {
          body: {
            name: spec.name,
            category: spec.category,
            subtitle: spec.subtitle,
          },
        });
      }
      if (spec.inactive && row.isActive !== false) {
        await call('PATCH', `/admin/payment-methods/${row.id}`, {
          body: { isActive: false },
        });
      }
    }

    const accounts = await call('GET', '/admin/payment-details');
    const accountRows = Array.isArray(accounts)
      ? accounts
      : (accounts.items ?? []);
    for (const spec of BANK_ACCOUNTS) {
      let row = accountRows.find((a) => a.clabe === spec.clabe);
      if (!row) {
        row = await call('POST', '/admin/payment-details', {
          body: {
            bankName: spec.bankName,
            beneficiary: spec.beneficiary,
            clabe: spec.clabe,
            accountNumber: spec.accountNumber,
          },
        });
      }
      if (spec.inactive && row.isActive !== false) {
        await call('DELETE', `/admin/payment-details/${row.id}`);
      }
    }
    const after = {
      methods: await prisma.paymentMethod.groupBy({
        by: ['isActive'],
        where: { tenantId: centro.id },
        _count: true,
      }),
      accounts: await prisma.paymentDetail.groupBy({
        by: ['isActive'],
        where: { tenantId: centro.id },
        _count: true,
      }),
    };
    return {
      paymentMethods: Object.fromEntries(
        after.methods.map((g) => [
          g.isActive ? 'active' : 'inactive',
          g._count,
        ]),
      ),
      bankAccounts: Object.fromEntries(
        after.accounts.map((g) => [
          g.isActive ? 'active' : 'inactive',
          g._count,
        ]),
      ),
    };
  });

  // ── System: notification config and catalog settings ─────────────────────
  // Last on purpose: with notifications on, the flows above must not emit mail.
  await section('system', async () => {
    const recipients = await prisma.user.findMany({
      where: { email: { in: [MANAGER, 'admin@houndfe.com'] } },
      select: { id: true },
    });
    const enabledActions = [
      'LOW_STOCK',
      'TIME_OFF_REQUESTED',
      'DELIVERY_NEXT_STOP',
      'PROMOTION_EXPIRING',
    ];
    await call('PUT', '/notification-config', {
      body: {
        enabled: true,
        recipientUserIds: recipients.map((u) => u.id),
        enabledActions,
      },
    });

    const lists = await prisma.globalPriceList.findMany({
      where: { name: { not: 'Online (dev)' } },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    });
    const fallback = lists.find((l) => l.isDefault) ?? lists[0];
    if (!fallback) {
      unsupported.push('Catálogo: no hay listas de precios para publicar');
      return { skipped: 'no price lists' };
    }
    const extra = lists.find(
      (l) => l.id !== fallback.id && l.name === 'Mayoreo',
    );
    const publicIds = [fallback.id, ...(extra ? [extra.id] : [])];
    const settings = await call(
      'PATCH',
      `/tenants/${centro.id}/catalog-settings`,
      {
        body: {
          catalogPublished: true,
          publicPriceListIds: publicIds,
          catalogDefaultPriceListId: fallback.id,
          stockPresentationDefault: { mode: 'SYSTEM_STATUS' },
        },
      },
    );
    return {
      notifications: {
        enabled: true,
        actionsOn: enabledActions,
        actionsOff: ['PROMOTION_NEAR_CAPACITY', 'DELIVERY_THANK_YOU'],
      },
      catalog: {
        published: settings.catalogPublished,
        publicLists: publicIds.length,
      },
    };
  });

  if (unsupported.length > 0) summary.unsupported = unsupported;
  return summary;
}

const DELIVERY_CUSTOMERS = [
  {
    firstName: 'Ana Lucía',
    lastName: 'Ibarra Méndez',
    phone: '5512340011',
    address: {
      street: 'Av. Universidad',
      exteriorNumber: '1450',
      interiorNumber: '302',
      zipCode: '03020',
      neighborhood: 'Narvarte Poniente',
      municipality: 'Benito Juárez',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      latitude: 19.3921,
      longitude: -99.1582,
    },
  },
  {
    firstName: 'Roberto',
    lastName: 'Salinas Ortiz',
    phone: '5512340022',
    address: {
      street: 'Eje 7 Sur Félix Cuevas',
      exteriorNumber: '312',
      zipCode: '03100',
      neighborhood: 'Del Valle Centro',
      municipality: 'Benito Juárez',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      latitude: 19.3868,
      longitude: -99.1698,
    },
  },
  {
    firstName: 'Marisol',
    lastName: 'Treviño Aguirre',
    phone: '5512340033',
    address: {
      street: 'Calle Orizaba',
      exteriorNumber: '87',
      interiorNumber: '4',
      zipCode: '06700',
      neighborhood: 'Roma Norte',
      municipality: 'Cuauhtémoc',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      latitude: 19.4189,
      longitude: -99.1627,
    },
  },
  {
    firstName: 'Héctor',
    lastName: 'Domínguez Pineda',
    phone: '5512340044',
    address: {
      street: 'Av. Ámsterdam',
      exteriorNumber: '226',
      zipCode: '06100',
      neighborhood: 'Hipódromo Condesa',
      municipality: 'Cuauhtémoc',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      latitude: 19.4118,
      longitude: -99.1717,
    },
  },
  {
    firstName: 'Verónica',
    lastName: 'Palacios Ruiz',
    phone: '5512340055',
    address: {
      street: 'Calle Pilares',
      exteriorNumber: '640',
      interiorNumber: '12',
      zipCode: '03810',
      neighborhood: 'Nápoles',
      municipality: 'Benito Juárez',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      latitude: 19.3949,
      longitude: -99.1763,
    },
  },
  {
    firstName: 'Sergio',
    lastName: 'Quintero Báez',
    phone: '5512340066',
    address: {
      street: 'Calle Insurgentes Sur',
      exteriorNumber: '1971',
      zipCode: '01020',
      neighborhood: 'Escandón',
      municipality: 'Miguel Hidalgo',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      latitude: 19.4037,
      longitude: -99.1802,
    },
  },
  {
    firstName: 'Paola',
    lastName: 'Escamilla Díaz',
    phone: '5512340077',
    address: {
      street: 'Av. Miguel Ángel de Quevedo',
      exteriorNumber: '785',
      zipCode: '04000',
      neighborhood: 'Coyoacán Centro',
      municipality: 'Coyoacán',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      latitude: 19.3467,
      longitude: -99.1618,
    },
  },
  {
    firstName: 'Jimena',
    lastName: 'Arriaga Lozano',
    phone: '5512340088',
    address: {
      street: 'Calle Rómulo O’Farril',
      exteriorNumber: '25',
      zipCode: '01460',
      neighborhood: 'Mixcoac',
      municipality: 'Benito Juárez',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
      latitude: 19.3745,
      longitude: -99.1869,
    },
  },
];

module.exports = { name: 'ops', run };
