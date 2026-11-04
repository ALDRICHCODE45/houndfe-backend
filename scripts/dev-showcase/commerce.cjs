'use strict';
// Dev showcase — commerce module: customers, sales, quotations, promotions and
// cash registers for Sucursal Centro (dev DB is disposable, names are demo data).
//
// Contract: `run(ctx)` is idempotent. Every demo entity is matched by a readable
// natural key (customer name, promotion title, register name, quotation notes) or
// by a deterministic idempotency key (`showcase:sale:<slug>`, `showcase:cash:…`),
// so a re-run creates nothing new. Stateful flows go through the real HTTP API
// (sale charge/cancel/payments/refund settlement, quotation send/cancel, cash
// session lifecycle); Prisma is used only where no endpoint exists:
//   - RolePermission grants for the demo roles (additive, never deleted);
//   - backdating `createdAt`/`confirmedAt`/`canceledAt` (and the matching cash
//     ledger/session timestamps) so the dashboard, month filters and cash
//     history have history. The API always stamps "now". Stock-journal
//     movements of backdated sales keep their real creation time.
// Dates are relative to `ctx.today`; the business timezone has a fixed UTC-6
// offset (America/Mexico_City, no DST), used only to pick local hours of day.

const DAY_MS = 86_400_000;
const MX_UTC_OFFSET_HOURS = 6;
const TENANT_SLUG_LABEL = 'Sucursal Centro';

const CASHIER_EMAIL = 'cashier@houndfe.com';
const MANAGER_EMAIL = 'manager@houndfe.com';

// ---------------------------------------------------------------------------
// Demo role grants (additive). Base seed gives Cashier only create/read Sale and
// Manager no quotation/promotion/cash access, so the POS and cash flows could
// not be exercised by realistic users.
// ---------------------------------------------------------------------------
const ROLE_GRANTS = {
  Cashier: [
    ['update', 'Sale'],
    ['read', 'Promotion'],
    ['create', 'CashSession'],
    ['create', 'CashCount'],
    ['create', 'CashIn'],
    ['create', 'CashOut'],
    ['create', 'CashHandover'],
    ['read', 'CashRegister'],
    ['read', 'CashSession'],
    ['read', 'CashHandover'],
    ['update', 'CashHandover'],
    ['read', 'SaleRefund'],
    ['update', 'SaleRefund'],
  ],
  Manager: [
    ['create', 'Quotation'],
    ['read', 'Quotation'],
    ['update', 'Quotation'],
    ['delete', 'Quotation'],
    ['create', 'Promotion'],
    ['read', 'Promotion'],
    ['update', 'Promotion'],
    ['delete', 'Promotion'],
    ['read', 'SaleRefund'],
    ['update', 'SaleRefund'],
    ['create', 'CashRegister'],
    ['update', 'CashRegister'],
    ['read', 'CashRegister'],
    ['read', 'CashSession'],
    ['read', 'CashSessionAudit'],
    ['read', 'CashClosing'],
    ['read', 'CashHandover'],
    ['update', 'CashHandover'],
    ['create', 'CashVerification'],
    ['create', 'CashClosing'],
  ],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
class ShowcaseError extends Error {}

function describe(res) {
  const body =
    res.body && typeof res.body === 'object'
      ? res.body.message || res.body.error || res.body.code
      : res.body;
  return `HTTP ${res.status}${body ? ` ${JSON.stringify(body).slice(0, 240)}` : ''}`;
}

// Calls the API and throws a descriptive error unless the status is expected.
async function call(ctx, token, method, path, { body, headers, ok } = {}) {
  const res = await ctx.api.http(method, path, { token, body, headers });
  const expected = ok || [200, 201, 204];
  if (!expected.includes(res.status)) {
    throw new ShowcaseError(`${method} ${path} → ${describe(res)}`);
  }
  return res.body;
}

// Local wall-clock instant `daysAgo` days before today, at `hour:minute` MX time.
function localInstant(today, daysAgo, hour, minute = 0) {
  const mxNow = new Date(today.getTime() - MX_UTC_OFFSET_HOURS * 3_600_000);
  const day = new Date(
    Date.UTC(
      mxNow.getUTCFullYear(),
      mxNow.getUTCMonth(),
      mxNow.getUTCDate() - daysAgo,
      hour + MX_UTC_OFFSET_HOURS,
      minute,
    ),
  );
  return day;
}

// Never in the future: a "today" instant later than now is pulled back to now.
function pastInstant(ctx, daysAgo, hour, minute = 0) {
  const instant = localInstant(ctx.today, daysAgo, hour, minute);
  return instant.getTime() > ctx.today.getTime()
    ? new Date(ctx.today.getTime() - 5 * 60_000)
    : instant;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
const CUSTOMERS = [
  {
    key: 'ana',
    firstName: 'Ana Sofía',
    lastName: 'Ramírez Lozano',
    phone: '5512345601',
    email: 'ana.ramirez@correo.mx',
    isTrusted: true,
    addresses: [
      {
        street: 'Av. Insurgentes Sur',
        exteriorNumber: '1602',
        interiorNumber: '4B',
        zipCode: '03940',
        neighborhood: 'Crédito Constructor',
        municipality: 'Benito Juárez',
        city: 'Ciudad de México',
        state: 'Ciudad de México',
        latitude: 19.3686,
        longitude: -99.1787,
      },
      {
        street: 'Calle Amsterdam',
        exteriorNumber: '87',
        zipCode: '06100',
        neighborhood: 'Hipódromo Condesa',
        municipality: 'Cuauhtémoc',
        city: 'Ciudad de México',
        state: 'Ciudad de México',
        latitude: 19.4119,
        longitude: -99.1706,
      },
    ],
  },
  {
    key: 'carlos',
    firstName: 'Carlos',
    lastName: 'Mendoza Treviño',
    phone: '8183457712',
    email: 'carlos.mendoza@correo.mx',
    addresses: [
      {
        street: 'Calle Hidalgo',
        exteriorNumber: '420',
        zipCode: '64000',
        neighborhood: 'Centro',
        municipality: 'Monterrey',
        city: 'Monterrey',
        state: 'Nuevo León',
        latitude: 25.6694,
        longitude: -100.3099,
      },
    ],
  },
  {
    key: 'lucia',
    firstName: 'Lucía',
    lastName: 'Fernández Ortega',
    phone: '3312908845',
    email: 'lucia.fernandez@correo.mx',
    addresses: [
      {
        street: 'Av. Chapultepec Sur',
        exteriorNumber: '215',
        interiorNumber: '12',
        zipCode: '44160',
        neighborhood: 'Americana',
        municipality: 'Guadalajara',
        city: 'Guadalajara',
        state: 'Jalisco',
        latitude: 20.6738,
        longitude: -103.3649,
      },
      {
        street: 'Calle Libertad',
        exteriorNumber: '1180',
        zipCode: '44100',
        neighborhood: 'Lafayette',
        municipality: 'Guadalajara',
        city: 'Guadalajara',
        state: 'Jalisco',
        latitude: 20.6769,
        longitude: -103.3705,
      },
      {
        street: 'Calzada Independencia Norte',
        exteriorNumber: '3340',
        zipCode: '44340',
        neighborhood: 'Independencia',
        municipality: 'Guadalajara',
        city: 'Guadalajara',
        state: 'Jalisco',
        latitude: 20.7036,
        longitude: -103.3341,
      },
    ],
  },
  {
    key: 'miguel',
    firstName: 'Miguel Ángel',
    lastName: 'Torres Guzmán',
    phone: '2221786534',
    addresses: [
      {
        street: 'Calle 5 de Mayo',
        exteriorNumber: '308',
        zipCode: '72000',
        neighborhood: 'Centro Histórico',
        municipality: 'Puebla',
        city: 'Puebla',
        state: 'Puebla',
        latitude: 19.0437,
        longitude: -98.1981,
      },
    ],
  },
  {
    key: 'valeria',
    firstName: 'Valeria',
    lastName: 'Domínguez Cruz',
    phone: '4423318896',
    email: 'valeria.dominguez@correo.mx',
    addresses: [
      {
        street: 'Av. Universidad',
        exteriorNumber: '95',
        interiorNumber: '2',
        zipCode: '76010',
        neighborhood: 'Álamos 2a Sección',
        municipality: 'Querétaro',
        city: 'Querétaro',
        state: 'Querétaro',
        latitude: 20.5976,
        longitude: -100.3918,
      },
    ],
  },
  {
    key: 'roberto',
    firstName: 'Roberto',
    lastName: 'Aguilar Sánchez',
    phone: '5598761230',
    addresses: [],
  },
  {
    key: 'daniela',
    firstName: 'Daniela',
    lastName: 'Pérez Villanueva',
    phone: '5544120987',
    email: 'daniela.perez@correo.mx',
    addresses: [
      {
        street: 'Calle Moliere',
        exteriorNumber: '46',
        zipCode: '11560',
        neighborhood: 'Polanco',
        municipality: 'Miguel Hidalgo',
        city: 'Ciudad de México',
        state: 'Ciudad de México',
        latitude: 19.4325,
        longitude: -99.1908,
      },
      {
        street: 'Av. Revolución',
        exteriorNumber: '1267',
        zipCode: '01090',
        neighborhood: 'Los Alpes',
        municipality: 'Álvaro Obregón',
        city: 'Ciudad de México',
        state: 'Ciudad de México',
        latitude: 19.3569,
        longitude: -99.1891,
      },
    ],
  },
  {
    key: 'javier',
    firstName: 'Javier',
    lastName: 'Cortés Navarro',
    phone: '6621450093',
    addresses: [
      {
        street: 'Blvd. Kino',
        exteriorNumber: '712',
        zipCode: '83010',
        neighborhood: 'Lomas del Pitic',
        municipality: 'Hermosillo',
        city: 'Hermosillo',
        state: 'Sonora',
        latitude: 29.0966,
        longitude: -110.9588,
      },
    ],
  },
  {
    key: 'fernanda',
    firstName: 'Fernanda',
    lastName: 'Ibarra Montes',
    phone: '9992204455',
    email: 'fernanda.ibarra@correo.mx',
    addresses: [
      {
        street: 'Calle 60',
        exteriorNumber: '501',
        zipCode: '97000',
        neighborhood: 'Centro',
        municipality: 'Mérida',
        city: 'Mérida',
        state: 'Yucatán',
        latitude: 20.9674,
        longitude: -89.6237,
      },
    ],
  },
  {
    key: 'hector',
    firstName: 'Héctor',
    lastName: 'Salinas Rojas',
    phone: '8112239087',
    addresses: [],
  },
  {
    key: 'patricia',
    firstName: 'Patricia',
    lastName: 'Luna Castañeda',
    phone: '4771326650',
    email: 'patricia.luna@correo.mx',
    addresses: [
      {
        street: 'Blvd. Adolfo López Mateos',
        exteriorNumber: '2210',
        zipCode: '37150',
        neighborhood: 'Las Hilamas',
        municipality: 'León',
        city: 'León',
        state: 'Guanajuato',
        latitude: 21.1325,
        longitude: -101.6868,
      },
    ],
  },
  {
    key: 'andres',
    firstName: 'Andrés',
    lastName: 'Vargas Espinoza',
    phone: '7771895543',
    addresses: [
      {
        street: 'Av. Morelos',
        exteriorNumber: '77',
        zipCode: '62000',
        neighborhood: 'Centro',
        municipality: 'Cuernavaca',
        city: 'Cuernavaca',
        state: 'Morelos',
        latitude: 18.9242,
        longitude: -99.2216,
      },
    ],
  },
  {
    key: 'mariana',
    firstName: 'Mariana',
    lastName: 'Ochoa Beltrán',
    phone: '6671204478',
    email: 'mariana.ochoa@correo.mx',
    addresses: [
      {
        street: 'Blvd. Zapata',
        exteriorNumber: '19',
        interiorNumber: '3',
        zipCode: '80020',
        neighborhood: 'Tierra Blanca',
        municipality: 'Culiacán',
        city: 'Culiacán',
        state: 'Sinaloa',
        latitude: 24.8091,
        longitude: -107.394,
      },
    ],
  },
  {
    key: 'ricardo',
    firstName: 'Ricardo',
    lastName: 'Herrera Paredes',
    phone: '5560098123',
    addresses: [],
  },
  {
    key: 'gabriela',
    firstName: 'Gabriela',
    lastName: 'Soto Villaseñor',
    phone: '3338825164',
    email: 'gabriela.soto@correo.mx',
    addresses: [
      {
        street: 'Av. Vallarta',
        exteriorNumber: '6503',
        zipCode: '45010',
        neighborhood: 'Ciudad Granja',
        municipality: 'Zapopan',
        city: 'Zapopan',
        state: 'Jalisco',
        latitude: 20.6736,
        longitude: -103.4262,
      },
    ],
  },
  {
    key: 'eduardo',
    firstName: 'Eduardo',
    lastName: 'Barrios Cabrera',
    phone: '5547713360',
    addresses: [],
  },
  {
    key: 'sofia',
    firstName: 'Sofía',
    lastName: 'Rangel Montoya',
    phone: '4422001978',
    email: 'sofia.rangel@correo.mx',
    addresses: [
      {
        street: 'Calle Corregidora',
        exteriorNumber: '140',
        zipCode: '76000',
        neighborhood: 'Centro',
        municipality: 'Querétaro',
        city: 'Querétaro',
        state: 'Querétaro',
        latitude: 20.5931,
        longitude: -100.3899,
      },
    ],
  },
  {
    key: 'veterinaria',
    firstName: 'Veterinaria San Francisco de Asís',
    lastName: 'S.A. de C.V.',
    phone: '5553204411',
    email: 'compras@vetsanfrancisco.com.mx',
    isTrusted: true,
    comments: 'Compra al mayoreo cada quincena. Factura siempre.',
    businessName: 'Veterinaria San Francisco de Asís S.A. de C.V.',
    rfc: 'VSF150312KT4',
    fiscalRegime: '601',
    fiscalZipCode: '03100',
    billingStreet: 'Av. Coyoacán',
    billingExteriorNumber: '1450',
    billingZipCode: '03100',
    billingNeighborhood: 'Del Valle Centro',
    billingMunicipality: 'Benito Juárez',
    billingCity: 'Ciudad de México',
    billingState: 'Ciudad de México',
    addresses: [
      {
        street: 'Av. Coyoacán',
        exteriorNumber: '1450',
        zipCode: '03100',
        neighborhood: 'Del Valle Centro',
        municipality: 'Benito Juárez',
        city: 'Ciudad de México',
        state: 'Ciudad de México',
        latitude: 19.3856,
        longitude: -99.1672,
      },
      {
        street: 'Calle Xola',
        exteriorNumber: '908',
        zipCode: '03020',
        neighborhood: 'Narvarte Poniente',
        municipality: 'Benito Juárez',
        city: 'Ciudad de México',
        state: 'Ciudad de México',
        latitude: 19.3947,
        longitude: -99.1559,
      },
    ],
  },
  {
    key: 'larga',
    firstName: 'María Guadalupe de los Ángeles',
    lastName: 'Hernández-Villanueva y Santamaría de la Peña',
    phone: '5517742290',
    email: 'maria.guadalupe.hernandez@correo.mx',
    comments: 'Prefiere entregas por la tarde. Nombre completo en facturas.',
    addresses: [
      {
        street: 'Privada de los Laureles',
        exteriorNumber: '12',
        zipCode: '52786',
        neighborhood: 'Interlomas',
        municipality: 'Huixquilucan',
        city: 'Huixquilucan',
        state: 'Estado de México',
        latitude: 19.3925,
        longitude: -99.2762,
      },
    ],
  },
  {
    key: 'tienda',
    firstName: 'Estética Canina Patitas Felices',
    lastName: 'Gómez Arellano',
    phone: '5530184421',
    email: 'patitasfelices@correo.mx',
    comments: 'Cliente de crédito: paga a 15 días.',
    addresses: [
      {
        street: 'Calle Tonalá',
        exteriorNumber: '63',
        zipCode: '06700',
        neighborhood: 'Roma Norte',
        municipality: 'Cuauhtémoc',
        city: 'Ciudad de México',
        state: 'Ciudad de México',
        latitude: 19.4194,
        longitude: -99.1615,
      },
    ],
  },
];

function customerKeyOf(spec) {
  return { firstName: spec.firstName, lastName: spec.lastName };
}

async function ensureCustomers(ctx, state) {
  const { prisma, centro } = ctx;
  const token = state.tokens.manager;
  let created = 0;
  let addressesCreated = 0;
  state.customers = {};
  for (const spec of CUSTOMERS) {
    let row = await prisma.customer.findFirst({
      where: { tenantId: centro.id, ...customerKeyOf(spec) },
      include: { addresses: { orderBy: { createdAt: 'asc' } } },
    });
    if (!row) {
      const { addresses, ...fields } = spec;
      const body = {
        ...fields,
        phoneCountryCode: '52',
        addresses: addresses.map((a) => ({ ...a })),
      };
      delete body.key;
      delete body.isTrusted;
      const made = await call(ctx, token, 'POST', '/customers', {
        body,
        ok: [201],
      });
      row = await prisma.customer.findFirstOrThrow({
        where: { id: made.id, tenantId: centro.id },
        include: { addresses: { orderBy: { createdAt: 'asc' } } },
      });
      created += 1;
      addressesCreated += addresses.length;
    }
    if (spec.isTrusted && !row.isTrusted) {
      await prisma.customer.update({
        where: { id: row.id },
        data: { isTrusted: true },
      });
    }
    state.customers[spec.key] = {
      id: row.id,
      addresses: row.addresses,
      name: `${spec.firstName} ${spec.lastName}`,
    };
  }
  return { created, addressesCreated, total: CUSTOMERS.length };
}

// ---------------------------------------------------------------------------
// Role grants + actors
// ---------------------------------------------------------------------------
async function ensureRoleGrants(ctx) {
  const { prisma, centro } = ctx;
  const added = [];
  for (const [roleName, grants] of Object.entries(ROLE_GRANTS)) {
    const role = await prisma.role.findFirst({
      where: { tenantId: centro.id, name: roleName },
    });
    if (!role) continue;
    for (const [action, subject] of grants) {
      const permission = await prisma.permission.upsert({
        where: { subject_action: { subject, action } },
        update: {},
        create: { subject, action },
      });
      const existing = await prisma.rolePermission.findUnique({
        where: {
          roleId_permissionId: { roleId: role.id, permissionId: permission.id },
        },
      });
      if (existing) continue;
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionId: permission.id },
      });
      added.push(`${roleName}: ${action}:${subject}`);
    }
  }
  return added;
}

async function resolveActors(ctx, state) {
  const { prisma } = ctx;
  const [cashier, manager] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: CASHIER_EMAIL } }),
    prisma.user.findUniqueOrThrow({ where: { email: MANAGER_EMAIL } }),
  ]);
  state.users = { cashier: cashier.id, manager: manager.id };
  state.tokens = {
    cashier: await ctx.api.login(CASHIER_EMAIL),
    manager: await ctx.api.login(MANAGER_EMAIL),
  };
}

// ---------------------------------------------------------------------------
// Product pool — chosen by availability, never by exact name. Demo/probe rows
// from earlier manual testing are excluded by name.
// ---------------------------------------------------------------------------
const JUNK_NAME =
  /prueba|probe|zz |no comercial|no publicado|variantes ocultas/i;

async function pickProducts(ctx, state) {
  const { prisma, centro } = ctx;
  const rows = await prisma.product.findMany({
    where: {
      tenantId: centro.id,
      type: 'PRODUCT',
      useStock: true,
      hasVariants: false,
      useLotsAndExpirations: false,
      sellInPos: true,
      quantity: { gte: 25 },
    },
    orderBy: [{ quantity: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, quantity: true },
    take: 60,
  });
  const pool = rows.filter((r) => !JUNK_NAME.test(r.name)).slice(0, 14);
  if (pool.length < 6) {
    throw new ShowcaseError(
      `commerce needs at least 6 sellable products with stock ≥ 25 in ${TENANT_SLUG_LABEL}; found ${pool.length}`,
    );
  }
  state.products = pool;
  return pool.length;
}

// Dedicated promotion targets so automatic promotions do not distort unrelated
// demo sales; everything else in the pool is "general" stock for sales.
function assignRoles(state) {
  const pool = state.products;
  state.promoLimited = pool[1];
  state.promoUnlimited = pool[2];
  state.advancedBuy = pool[3];
  state.advancedGet = pool[4];
  const reserved = new Set(pool.slice(1, 5).map((p) => p.id));
  state.general = pool.filter((p) => !reserved.has(p.id));
}

// The i-th general product (wraps around when the catalog is small).
function general(state, index) {
  return state.general[index % state.general.length];
}

// ---------------------------------------------------------------------------
// Promotions: every type × active / scheduled / ended. Titles are the natural
// key. `start`/`end` are day offsets from today (negative = past).
// ---------------------------------------------------------------------------
function promotionSpecs(state) {
  const limited = state.promoLimited.id;
  const unlimited = state.promoUnlimited.id;
  const buy = state.advancedBuy.id;
  const get = state.advancedGet.id;
  const targets = (id) => [{ targetType: 'PRODUCTS', targetId: id }];
  return [
    // PRODUCT_DISCOUNT
    {
      title: 'Semana de la mascota: 15% de descuento',
      type: 'PRODUCT_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: 'PERCENTAGE',
      discountValue: 15,
      appliesTo: 'PRODUCTS',
      targetItems: targets(unlimited),
      start: -5,
      end: null,
    },
    {
      title: 'Cliente frecuente: $20 menos en tu producto favorito',
      type: 'PRODUCT_DISCOUNT',
      method: 'MANUAL',
      discountType: 'FIXED',
      discountValue: 2000,
      appliesTo: 'PRODUCTS',
      targetItems: targets(unlimited),
      customerScope: 'REGISTERED_ONLY',
      start: -20,
      end: 25,
    },
    {
      title: 'Regreso a clases de tu mascota: 20% de descuento',
      type: 'PRODUCT_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: 'PERCENTAGE',
      discountValue: 20,
      appliesTo: 'PRODUCTS',
      targetItems: targets(unlimited),
      start: 6,
      end: 21,
    },
    {
      title: 'Liquidación de verano: 25% de descuento',
      type: 'PRODUCT_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: 'PERCENTAGE',
      discountValue: 25,
      appliesTo: 'PRODUCTS',
      targetItems: targets(unlimited),
      start: -60,
      end: -32,
    },
    // ORDER_DISCOUNT
    {
      title: 'Compra $1,500 y ahorra $150',
      type: 'ORDER_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: 'FIXED',
      discountValue: 15000,
      minPurchaseAmountCents: 150000,
      start: -10,
      end: 20,
    },
    {
      title: 'Buen Fin: 10% en toda tu compra',
      type: 'ORDER_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: 'PERCENTAGE',
      discountValue: 10,
      start: 12,
      end: 15,
    },
    {
      title: 'Hot Sale: $200 de descuento en compras mayores a $2,000',
      type: 'ORDER_DISCOUNT',
      method: 'AUTOMATIC',
      discountType: 'FIXED',
      discountValue: 20000,
      minPurchaseAmountCents: 200000,
      start: -48,
      end: -40,
    },
    // BUY_X_GET_Y — the active one has a small cap that real sales nearly use up
    {
      title: 'Llévate 3 y paga 2 en alimento húmedo',
      type: 'BUY_X_GET_Y',
      method: 'AUTOMATIC',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 100,
      appliesTo: 'PRODUCTS',
      targetItems: targets(limited),
      maxProductUnits: 12,
      start: -15,
      end: 30,
    },
    {
      title: '2x1 en premios: el segundo a mitad de precio',
      type: 'BUY_X_GET_Y',
      method: 'AUTOMATIC',
      buyQuantity: 1,
      getQuantity: 1,
      getDiscountPercent: 50,
      appliesTo: 'PRODUCTS',
      targetItems: targets(limited),
      start: 8,
      end: 22,
    },
    {
      title: 'Aniversario: lleva 2 y el tercero con 50% de descuento',
      type: 'BUY_X_GET_Y',
      method: 'AUTOMATIC',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 50,
      appliesTo: 'PRODUCTS',
      targetItems: targets(limited),
      start: -70,
      end: -45,
    },
    // ADVANCED
    {
      title: 'Compra tu alimento y lleva un complemento a mitad de precio',
      type: 'ADVANCED',
      method: 'AUTOMATIC',
      buyQuantity: 1,
      getQuantity: 1,
      getDiscountPercent: 50,
      buyTargetType: 'PRODUCTS',
      getTargetType: 'PRODUCTS',
      buyTargetItems: [{ targetId: buy }],
      getTargetItems: [{ targetId: get }],
      maxProductUnits: 400,
      start: -3,
      end: 40,
    },
    {
      title: 'Combo de temporada: complemento gratis al comprar alimento',
      type: 'ADVANCED',
      method: 'AUTOMATIC',
      buyQuantity: 2,
      getQuantity: 1,
      getDiscountPercent: 100,
      buyTargetType: 'PRODUCTS',
      getTargetType: 'PRODUCTS',
      buyTargetItems: [{ targetId: buy }],
      getTargetItems: [{ targetId: get }],
      start: 9,
      end: 30,
    },
    {
      title:
        'Día del cliente: compra alimento húmedo y lleva un complemento gratis',
      type: 'ADVANCED',
      method: 'MANUAL',
      buyQuantity: 1,
      getQuantity: 1,
      getDiscountPercent: 100,
      buyTargetType: 'PRODUCTS',
      getTargetType: 'PRODUCTS',
      buyTargetItems: [{ targetId: limited }],
      getTargetItems: [{ targetId: get }],
      start: -90,
      end: -60,
    },
  ];
}

async function ensurePromotions(ctx, state) {
  const { prisma, centro } = ctx;
  const token = state.tokens.manager;
  const specs = promotionSpecs(state);
  let created = 0;
  state.promotions = {};
  for (const spec of specs) {
    let row = await prisma.promotion.findFirst({
      where: { tenantId: centro.id, title: spec.title },
    });
    if (!row) {
      const { start, end, ...rest } = spec;
      const body = { ...rest };
      body.startDate = pastOrFuture(ctx, start);
      if (end !== null) body.endDate = pastOrFuture(ctx, end);
      const made = await call(ctx, token, 'POST', '/promotions', {
        body,
        ok: [201],
      });
      row = await prisma.promotion.findFirstOrThrow({
        where: { id: made.id, tenantId: centro.id },
      });
      created += 1;
    }
    state.promotions[spec.title] = row.id;
  }
  return { created, total: specs.length };
}

// ISO instant `offsetDays` from today (the API snaps it to business-day bounds).
function pastOrFuture(ctx, offsetDays) {
  return new Date(ctx.today.getTime() + offsetDays * DAY_MS).toISOString();
}

// ---------------------------------------------------------------------------
// Sales. `slug` is the readable natural key; the charge idempotency key is
// `showcase:sale:<slug>`, which is also how a re-run finds the sale again.
// Line sources: gN = general product N, PL = limited promo product, PU =
// unlimited promo product. Only DELIVERED-pending (delivery) sales can be
// cancelled by the domain, so every cancelled demo sale is a delivery sale.
// ---------------------------------------------------------------------------
const SALES = [
  // -- Caja Bodega (en desuso), cerrada hace 21 días
  {
    slug: 'bodega-01',
    day: 21,
    hour: 10,
    by: 'cashier',
    session: 'bodega-1',
    lines: [['g0', 2]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'bodega-02',
    day: 21,
    hour: 12,
    by: 'cashier',
    session: 'bodega-1',
    lines: [
      ['g1', 1],
      ['g3', 1],
    ],
    pay: { kind: 'card_debit' },
  },
  {
    slug: 'bodega-03',
    day: 21,
    hour: 16,
    by: 'cashier',
    session: 'bodega-1',
    customer: 'ana',
    lines: [['g2', 3]],
    pay: { kind: 'transfer' },
  },
  // -- Caja Mostrador 2, cerrada hace 12 días (con faltante)
  {
    slug: 'mostrador-01',
    day: 12,
    hour: 9,
    by: 'cashier',
    session: 'mostrador-1',
    lines: [['g1', 2]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'mostrador-02',
    day: 12,
    hour: 11,
    by: 'cashier',
    session: 'mostrador-1',
    lines: [
      ['g0', 1],
      ['g4', 2],
    ],
    pay: { kind: 'card_credit' },
  },
  {
    slug: 'mostrador-03',
    day: 12,
    hour: 14,
    by: 'cashier',
    session: 'mostrador-1',
    customer: 'valeria',
    lines: [['g2', 1]],
    pay: { kind: 'cash', exact: true },
  },
  {
    slug: 'mostrador-04',
    day: 12,
    hour: 18,
    by: 'cashier',
    session: 'mostrador-1',
    lines: [['g5', 1]],
    pay: { kind: 'cash' },
  },
  // -- Caja Principal, cerrada hace 8 días (deja fondo para la siguiente)
  {
    slug: 'principal-01',
    day: 8,
    hour: 10,
    by: 'cashier',
    session: 'principal-1',
    customer: 'carlos',
    lines: [['g0', 3]],
    pay: {
      kind: 'mixed',
      parts: [
        ['cash', 0.4],
        ['card_debit', 0.6],
      ],
    },
  },
  {
    slug: 'principal-02',
    day: 8,
    hour: 12,
    by: 'cashier',
    session: 'principal-1',
    lines: [['g3', 2]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'principal-03',
    day: 8,
    hour: 13,
    by: 'cashier',
    session: 'principal-1',
    lines: [['PL', 3]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'principal-04',
    day: 8,
    hour: 16,
    by: 'cashier',
    session: 'principal-1',
    customer: 'lucia',
    lines: [['g1', 2]],
    pay: { kind: 'transfer' },
  },
  {
    slug: 'principal-05',
    day: 8,
    hour: 19,
    by: 'cashier',
    session: 'principal-1',
    lines: [['g6', 1]],
    pay: { kind: 'cash' },
  },
  // -- Caja Mostrador 2, cerrada hace 4 días (cuadrada)
  {
    slug: 'mostrador-05',
    day: 4,
    hour: 9,
    by: 'cashier',
    session: 'mostrador-2',
    lines: [['g0', 1]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'mostrador-06',
    day: 4,
    hour: 13,
    by: 'cashier',
    session: 'mostrador-2',
    customer: 'daniela',
    lines: [['g2', 2]],
    pay: { kind: 'card_debit' },
  },
  {
    slug: 'mostrador-07',
    day: 4,
    hour: 17,
    by: 'cashier',
    session: 'mostrador-2',
    lines: [['g4', 1]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'mostrador-08',
    day: 4,
    hour: 18,
    by: 'cashier',
    session: 'mostrador-2',
    lines: [['PU', 2]],
    pay: { kind: 'cash', exact: true },
  },
  // -- Caja Express, con corte enviado y entrega de custodia pendiente
  {
    slug: 'express-01',
    day: 1,
    hour: 9,
    by: 'cashier',
    session: 'express-1',
    lines: [['g1', 1]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'express-02',
    day: 1,
    hour: 12,
    by: 'cashier',
    session: 'express-1',
    customer: 'miguel',
    lines: [['g3', 2]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'express-03',
    day: 1,
    hour: 15,
    by: 'cashier',
    session: 'express-1',
    lines: [['g0', 2]],
    pay: { kind: 'card_credit' },
  },
  // -- Caja Principal, sesión abierta hoy
  {
    slug: 'hoy-01',
    day: 0,
    hour: 9,
    by: 'cashier',
    session: 'principal-hoy',
    lines: [['g0', 1]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'hoy-02',
    day: 0,
    hour: 10,
    by: 'cashier',
    session: 'principal-hoy',
    customer: 'andres',
    lines: [['g2', 2]],
    pay: { kind: 'transfer' },
  },
  {
    slug: 'hoy-03',
    day: 0,
    hour: 11,
    by: 'cashier',
    session: 'principal-hoy',
    lines: [['PL', 6]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'hoy-04',
    day: 0,
    hour: 12,
    by: 'cashier',
    session: 'principal-hoy',
    customer: 'ricardo',
    lines: [
      ['g1', 1],
      ['g5', 2],
    ],
    pay: {
      kind: 'mixed',
      parts: [
        ['cash', 0.5],
        ['card_credit', 0.5],
      ],
    },
  },
  {
    slug: 'hoy-05',
    day: 0,
    hour: 13,
    by: 'cashier',
    session: 'principal-hoy',
    customer: 'valeria',
    delivery: true,
    lines: [['g3', 1]],
    pay: { kind: 'cash', exact: true },
    cancel: {
      reason: 'CUSTOMER_REQUEST',
      afterHours: 1,
      settle: { ratio: 0.5, method: 'cash' },
    },
  },
  // -- Ventas fuera de caja: mostrador histórico, crédito, entregas y cancelaciones
  {
    slug: 'mes-01',
    day: 26,
    hour: 11,
    by: 'cashier',
    lines: [['g0', 2]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'mes-02',
    day: 25,
    hour: 16,
    by: 'manager',
    lines: [['g3', 1]],
    pay: { kind: 'card_credit' },
  },
  {
    slug: 'mes-03',
    day: 24,
    hour: 10,
    by: 'cashier',
    customer: 'ana',
    lines: [['g1', 3]],
    pay: { kind: 'card_debit' },
  },
  {
    slug: 'mes-04',
    day: 23,
    hour: 13,
    by: 'manager',
    customer: 'veterinaria',
    lines: [
      ['g0', 10],
      ['g2', 6],
    ],
    pay: { kind: 'credit' },
    dueInDays: 15,
  },
  {
    slug: 'mes-05',
    day: 22,
    hour: 12,
    by: 'cashier',
    lines: [['g5', 2]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'mes-06',
    day: 20,
    hour: 15,
    by: 'cashier',
    customer: 'hector',
    lines: [['g4', 2]],
    pay: { kind: 'credit' },
    dueInDays: 10,
  },
  {
    slug: 'mes-07',
    day: 19,
    hour: 10,
    by: 'manager',
    customer: 'tienda',
    lines: [['g3', 4]],
    pay: { kind: 'partial', ratio: 0.4 },
    dueInDays: 30,
  },
  {
    slug: 'mes-08',
    day: 18,
    hour: 17,
    by: 'cashier',
    customer: 'patricia',
    lines: [['g1', 2]],
    pay: { kind: 'transfer' },
  },
  {
    slug: 'mes-09',
    day: 17,
    hour: 11,
    by: 'cashier',
    lines: [['g6', 3]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'mes-10',
    day: 16,
    hour: 14,
    by: 'cashier',
    customer: 'larga',
    lines: [
      ['g2', 2],
      ['g4', 1],
    ],
    pay: { kind: 'cash' },
  },
  {
    slug: 'mes-11',
    day: 15,
    hour: 12,
    by: 'manager',
    customer: 'mariana',
    lines: [['g0', 3]],
    pay: { kind: 'card_credit' },
  },
  {
    slug: 'mes-12',
    day: 14,
    hour: 9,
    by: 'cashier',
    customer: 'andres',
    delivery: true,
    lines: [['g1', 1]],
    pay: { kind: 'cash' },
    cancel: { reason: 'CUSTOMER_REQUEST', afterHours: 5 },
  },
  {
    slug: 'mes-13',
    day: 13,
    hour: 16,
    by: 'cashier',
    customer: 'eduardo',
    lines: [['g5', 2]],
    pay: { kind: 'credit' },
    dueInDays: 5,
  },
  {
    slug: 'mes-14',
    day: 11,
    hour: 13,
    by: 'manager',
    customer: 'veterinaria',
    lines: [['g1', 8]],
    pay: {
      kind: 'mixed',
      parts: [
        ['transfer', 0.6],
        ['card_credit', 0.4],
      ],
    },
  },
  {
    slug: 'mes-15',
    day: 10,
    hour: 11,
    by: 'cashier',
    customer: 'fernanda',
    delivery: true,
    lines: [['g2', 2]],
    pay: { kind: 'transfer' },
    cancel: {
      reason: 'ORDER_ERROR',
      afterHours: 3,
      settle: { ratio: 0.5, method: 'transfer' },
    },
  },
  {
    slug: 'mes-16',
    day: 9,
    hour: 10,
    by: 'cashier',
    lines: [['g3', 1]],
    pay: { kind: 'card_debit' },
  },
  {
    slug: 'mes-17',
    day: 7,
    hour: 12,
    by: 'manager',
    customer: 'javier',
    delivery: true,
    lines: [['g0', 2]],
    pay: { kind: 'cash', exact: true },
  },
  {
    slug: 'mes-18',
    day: 6,
    hour: 15,
    by: 'cashier',
    customer: 'larga',
    lines: [['g1', 2]],
    pay: { kind: 'partial', ratio: 0.3 },
    dueInDays: 12,
  },
  {
    slug: 'mes-19',
    day: 5,
    hour: 11,
    by: 'manager',
    customer: 'gabriela',
    delivery: true,
    lines: [['g4', 3]],
    pay: { kind: 'card_credit' },
  },
  {
    slug: 'mes-20',
    day: 3,
    hour: 14,
    by: 'cashier',
    lines: [['g6', 2]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'mes-21',
    day: 3,
    hour: 18,
    by: 'manager',
    customer: 'lucia',
    delivery: true,
    lines: [
      ['g2', 1],
      ['g5', 1],
    ],
    pay: { kind: 'transfer' },
  },
  {
    slug: 'mes-22',
    day: 2,
    hour: 10,
    by: 'cashier',
    customer: 'sofia',
    lines: [['g0', 2]],
    pay: { kind: 'partial', ratio: 0.5 },
    dueInDays: 7,
    collect: [{ afterDays: 1, method: 'cash', ratio: 0.2 }],
  },
  {
    slug: 'mes-23',
    day: 2,
    hour: 16,
    by: 'cashier',
    customer: 'tienda',
    lines: [['g1', 3]],
    pay: { kind: 'credit' },
    dueInDays: 15,
    collect: [{ afterDays: 1, method: 'transfer', ratio: 'rest' }],
  },
  {
    slug: 'mes-24',
    day: 1,
    hour: 11,
    by: 'manager',
    customer: 'ana',
    delivery: true,
    lines: [['g3', 2]],
    pay: { kind: 'cash' },
  },
  {
    slug: 'mes-25',
    day: 1,
    hour: 17,
    by: 'manager',
    customer: 'mariana',
    delivery: true,
    lines: [['g5', 1]],
    pay: { kind: 'card_credit' },
    cancel: { reason: 'OTHER', afterHours: 2 },
  },
  {
    slug: 'mes-26',
    day: 0,
    hour: 10,
    by: 'manager',
    customer: 'roberto',
    lines: [['g2', 2]],
    pay: { kind: 'credit' },
    dueInDays: 7,
  },
  {
    slug: 'mes-28',
    day: 17,
    hour: 16,
    by: 'manager',
    customer: 'veterinaria',
    lines: [['PL', 12]],
    pay: { kind: 'transfer' },
  },
  {
    slug: 'mes-29',
    day: 11,
    hour: 15,
    by: 'manager',
    customer: 'tienda',
    lines: [['PL', 12]],
    pay: { kind: 'card_credit' },
  },
  {
    slug: 'mes-27',
    day: 6,
    hour: 18,
    by: 'cashier',
    customer: 'miguel',
    delivery: true,
    lines: [['g0', 2]],
    pay: { kind: 'credit' },
    dueInDays: 3,
    cancel: { reason: 'OUT_OF_STOCK', afterHours: 4 },
  },
];

function digitsFor(slug, length) {
  const hash = require('node:crypto').createHash('sha1').update(slug).digest();
  let out = '';
  for (let i = 0; out.length < length; i += 1)
    out += String(hash[i % hash.length] % 10);
  return out;
}

function buildPayments(spec, total) {
  const pay = spec.pay;
  if (pay.kind === 'credit') {
    return { payments: [{ method: 'credit', amountCents: 0 }] };
  }
  if (pay.kind === 'cash') {
    // Customers hand over a round bill: next multiple of $50 (or $100 above).
    const step = total > 20000 ? 10000 : 5000;
    const tender = pay.exact ? total : Math.ceil(total / step) * step;
    return {
      payments: [{ method: 'cash', amountCents: Math.max(tender, total) }],
    };
  }
  if (pay.kind === 'card_credit' || pay.kind === 'card_debit') {
    return {
      payments: [
        {
          method: pay.kind,
          amountCents: total,
          reference: `Aut. ${digitsFor(spec.slug, 6)}`,
        },
      ],
    };
  }
  if (pay.kind === 'transfer') {
    return {
      payments: [
        {
          method: 'transfer',
          amountCents: total,
          reference: `SPEI ${digitsFor(spec.slug, 10)}`,
        },
      ],
    };
  }
  if (pay.kind === 'mixed') {
    const payments = [];
    let remaining = total;
    pay.parts.forEach(([method, ratio], index) => {
      const last = index === pay.parts.length - 1;
      const amount = last ? remaining : Math.max(Math.round(total * ratio), 1);
      remaining -= amount;
      const entry = { method, amountCents: amount };
      if (method === 'card_credit' || method === 'card_debit') {
        entry.reference = `Aut. ${digitsFor(spec.slug, 6)}`;
      }
      if (method === 'transfer')
        entry.reference = `SPEI ${digitsFor(spec.slug, 10)}`;
      payments.push(entry);
    });
    return { payments };
  }
  if (pay.kind === 'partial') {
    const cash = Math.max(Math.floor((total * pay.ratio) / 100) * 100, 100);
    return {
      payments: [{ method: 'cash', amountCents: Math.min(cash, total - 100) }],
    };
  }
  throw new ShowcaseError(`unknown payment kind ${pay.kind}`);
}

function lineProduct(state, source) {
  if (source === 'PL') return state.promoLimited;
  if (source === 'PU') return state.promoUnlimited;
  return general(state, Number(source.slice(1)));
}

async function findChargedSale(ctx, slug) {
  const record = await ctx.prisma.saleIdempotency.findFirst({
    where: {
      tenantId: ctx.centro.id,
      operation: 'sale_charge',
      key: `showcase:sale:${slug}`,
      status: 'SUCCEEDED',
    },
  });
  return record && record.saleId ? record.saleId : null;
}

async function saleRow(ctx, saleId) {
  return ctx.prisma.sale.findFirstOrThrow({
    where: { id: saleId, tenantId: ctx.centro.id },
    include: { payments: { orderBy: { createdAt: 'asc' } }, refunds: true },
  });
}

// Opens a draft, fills it and charges it. Returns the sale id (or null when the
// stock/customer prerequisites are not available, so the sale is skipped).
async function createAndCharge(ctx, state, spec, notes) {
  const token = state.tokens[spec.by];
  const draft = await call(ctx, token, 'POST', '/sales/drafts', { ok: [201] });
  const saleId = draft.id;
  try {
    let current = draft;
    for (const [source, quantity] of spec.lines) {
      const item = lineProduct(state, source);
      const fresh = await ctx.prisma.product.findFirstOrThrow({
        where: { id: item.id, tenantId: ctx.centro.id },
        select: { quantity: true },
      });
      if (fresh.quantity < quantity + 10) {
        throw new ShowcaseError(`low stock for ${item.name}`);
      }
      current = await call(
        ctx,
        token,
        'POST',
        `/sales/drafts/${saleId}/items`,
        {
          body: { productId: item.id, quantity },
        },
      );
    }
    if (spec.customer) {
      const customer = state.customers[spec.customer];
      const body = { customerId: customer.id };
      if (spec.delivery) {
        if (customer.addresses.length === 0) {
          throw new ShowcaseError(`customer ${spec.customer} has no address`);
        }
        body.shippingAddressId = customer.addresses[0].id;
      }
      current = await call(
        ctx,
        token,
        'PUT',
        `/sales/drafts/${saleId}/customer`,
        { body },
      );
    }
    const { payments } = buildPayments(spec, current.totalCents);
    // Credit is a single legacy-shaped tender; it cannot travel in `payments[]`.
    const body =
      spec.pay.kind === 'credit'
        ? { method: 'credit', amountCents: 0 }
        : { payments };
    if (spec.delivery) body.delivery = true;
    if (spec.session) {
      const session = state.sessions[spec.session];
      if (!session || session.status !== 'OPEN') {
        throw new ShowcaseError(`session ${spec.session} is not open`);
      }
      body.cashSessionId = session.id;
    }
    if (spec.dueInDays !== undefined) {
      // Real "now" + offset; adjusted to the backdated confirmation afterwards.
      body.dueDate = new Date(ctx.today.getTime() + 45 * DAY_MS).toISOString();
    }
    await call(ctx, token, 'POST', `/sales/drafts/${saleId}/charge`, {
      body,
      headers: { 'idempotency-key': `showcase:sale:${spec.slug}` },
      ok: [200, 201],
    });
    return saleId;
  } catch (error) {
    // An unfinished draft must not linger in the cashier's open drafts.
    await ctx.prisma.sale.deleteMany({
      where: { id: saleId, tenantId: ctx.centro.id, status: 'DRAFT' },
    });
    notes.push(`sale ${spec.slug} skipped: ${error.message}`);
    return null;
  }
}

async function applyFollowUps(ctx, state, spec, saleId) {
  const manager = state.tokens.manager;
  let row = await saleRow(ctx, saleId);

  // Collections after the sale (money received later).
  for (const [index, collect] of (spec.collect || []).entries()) {
    const key = `showcase:collect:${spec.slug}:${index}`;
    const done = await ctx.prisma.saleIdempotency.findFirst({
      where: { tenantId: ctx.centro.id, operation: 'sale_payment', key },
    });
    if (done || row.status !== 'CONFIRMED' || row.debtCents <= 0) continue;
    const amount =
      collect.ratio === 'rest'
        ? row.debtCents
        : Math.min(
            Math.round((row.totalCents * collect.ratio) / 100) * 100,
            row.debtCents - 100,
          );
    const entry = { method: collect.method, amountCents: amount };
    if (collect.method === 'transfer')
      entry.reference = `SPEI ${digitsFor(`${spec.slug}${index}`, 10)}`;
    // Collections are owner-scoped: the cashier who sold collects.
    await call(
      ctx,
      state.tokens[spec.by],
      'POST',
      `/sales/${saleId}/payments`,
      {
        body: entry,
        headers: { 'idempotency-key': key },
        ok: [200, 201],
      },
    );
    row = await saleRow(ctx, saleId);
  }

  // Cancellation (creates pending refund obligations for paid money).
  if (spec.cancel && row.status === 'CONFIRMED') {
    await call(ctx, manager, 'POST', `/sales/${saleId}/cancel`, {
      body: { reason: spec.cancel.reason },
    });
    row = await saleRow(ctx, saleId);
  }

  // Partial refund settlement of the first obligation. The settlement endpoint
  // cannot be called: it parses the refund id with ParseUUIDPipe, but
  // SaleRefund ids are cuids (schema `@default(cuid())`). The append-only
  // ledger row and the obligation counter are written directly instead, the
  // same two writes the service performs (never session-bound).
  if (spec.cancel && spec.cancel.settle && row.refunds.length > 0) {
    const refund = [...row.refunds].sort(
      (a, b) => a.createdAt - b.createdAt,
    )[0];
    const settled = await ctx.prisma.saleRefundSettlement.count({
      where: { tenantId: ctx.centro.id, saleRefundId: refund.id },
    });
    if (settled === 0) {
      const settle = spec.cancel.settle;
      const amountCents = Math.max(
        Math.round((refund.amountCents * settle.ratio) / 100) * 100,
        100,
      );
      const settledAt = new Date(
        (row.canceledAt || ctx.today).getTime() + 30 * 60_000,
      );
      await ctx.prisma.$transaction([
        ctx.prisma.saleRefundSettlement.create({
          data: {
            tenantId: ctx.centro.id,
            saleRefundId: refund.id,
            settledByUserId: state.users.manager,
            amountCents,
            method: settle.method.toUpperCase(),
            reference:
              settle.method === 'transfer'
                ? `SPEI ${digitsFor(`${spec.slug}refund`, 10)}`
                : null,
            settledAt,
          },
        }),
        ctx.prisma.saleRefund.update({
          where: { id: refund.id },
          data: { settledCents: { increment: amountCents } },
        }),
      ]);
    }
  }

  // Due date relative to the (backdated) confirmation, so overdue debts exist.
  row = await saleRow(ctx, saleId);
  if (spec.dueInDays !== undefined && row.status === 'CANCELED') {
    if (row.dueDate) {
      await ctx.prisma.sale.update({
        where: { id: saleId },
        data: { dueDate: null },
      });
    }
  } else if (spec.dueInDays !== undefined && row.status === 'CONFIRMED') {
    const confirmedAt = targetConfirmedAt(ctx, spec);
    const due = new Date(confirmedAt.getTime() + spec.dueInDays * DAY_MS);
    if (
      !row.dueDate ||
      Math.abs(row.dueDate.getTime() - due.getTime()) > 6 * 3_600_000
    ) {
      await ctx.prisma.sale.update({
        where: { id: saleId },
        data: { dueDate: due },
      });
    }
  }
}

function targetConfirmedAt(ctx, spec) {
  return pastInstant(ctx, spec.day, spec.hour, (spec.slug.length * 7) % 50);
}

// Same-day re-runs must not rewrite history; "today" rows get a tight bound.
const TOLERANCE_MS = 6 * 3_600_000;
const toleranceFor = (day) => (day === 0 ? 10 * 60_000 : TOLERANCE_MS);

// The API always stamps "now"; history is created by moving the timestamps.
async function backdateSale(ctx, spec, saleId) {
  const { prisma } = ctx;
  const row = await saleRow(ctx, saleId);
  const confirmedAt = targetConfirmedAt(ctx, spec);
  if (
    row.confirmedAt &&
    Math.abs(row.confirmedAt.getTime() - confirmedAt.getTime()) <=
      toleranceFor(spec.day)
  ) {
    return false;
  }
  const data = {
    confirmedAt,
    createdAt: new Date(confirmedAt.getTime() - 4 * 60_000),
  };
  let canceledAt = null;
  if (spec.cancel) {
    canceledAt = new Date(
      Math.min(
        confirmedAt.getTime() + (spec.cancel.afterHours || 2) * 3_600_000,
        ctx.today.getTime() - 60_000,
      ),
    );
    data.canceledAt = canceledAt;
  }
  await prisma.sale.update({ where: { id: saleId }, data });
  const collects = (spec.collect || []).length;
  const initial = Math.max(row.payments.length - collects, 0);
  for (const [index, payment] of row.payments.entries()) {
    const at =
      index < initial
        ? confirmedAt
        : new Date(
            Math.min(
              confirmedAt.getTime() +
                spec.collect[index - initial].afterDays * DAY_MS,
              ctx.today.getTime() - 30 * 60_000,
            ),
          );
    await prisma.salePayment.update({
      where: { id: payment.id },
      data: { createdAt: at },
    });
  }
  for (const refund of row.refunds) {
    await prisma.saleRefund.update({
      where: { id: refund.id },
      data: { createdAt: canceledAt || confirmedAt },
    });
    await prisma.saleRefundSettlement.updateMany({
      where: { tenantId: ctx.centro.id, saleRefundId: refund.id },
      data: {
        settledAt: new Date(
          (canceledAt || confirmedAt).getTime() + 30 * 60_000,
        ),
        createdAt: new Date(
          (canceledAt || confirmedAt).getTime() + 30 * 60_000,
        ),
      },
    });
  }
  return true;
}

async function processSale(ctx, state, spec, summary) {
  let saleId = await findChargedSale(ctx, spec.slug);
  if (!saleId) {
    saleId = await createAndCharge(ctx, state, spec, summary.notes);
    if (!saleId) return;
    summary.salesCreated += 1;
  }
  await applyFollowUps(ctx, state, spec, saleId);
  await backdateSale(ctx, spec, saleId);
  state.saleIds[spec.slug] = saleId;
}

// ---------------------------------------------------------------------------
// Cash: registers (active / inactive), sessions in every state and a pending
// custody handover. Everything goes through the API; only the history is moved
// back in time afterwards (session, counts, closing, handovers, ledger rows).
// ---------------------------------------------------------------------------
const REGISTERS = [
  { name: 'Caja Principal', active: true },
  { name: 'Caja Mostrador 2', active: true },
  { name: 'Caja Express', active: true },
  { name: 'Caja Bodega (en desuso)', active: false },
  { name: 'Caja Reparto foráneo', active: false },
];

// Chronological. `plan`: closed = counted, custody received, drawer released
// and closed by the manager; submitted = declared with a handover waiting for
// the manager's receipt; open = still operating today.
const SESSIONS = [
  {
    key: 'bodega-1',
    register: 'Caja Bodega (en desuso)',
    day: 21,
    openHour: 9,
    closeHour: 19,
    openingCents: 150000,
    plan: 'closed',
    movements: [
      {
        kind: 'out',
        cents: 18000,
        reason: 'Pago de flete de mercancía',
        hour: 13,
      },
    ],
  },
  {
    key: 'mostrador-1',
    register: 'Caja Mostrador 2',
    day: 12,
    openHour: 8,
    closeHour: 19,
    openingCents: 100000,
    plan: 'closed',
    diffCents: -5000,
    declarationNotes:
      'Faltante de $50: se entregó cambio de más en una venta de la tarde.',
    movements: [
      {
        kind: 'out',
        cents: 8500,
        reason: 'Compra de papelería y etiquetas',
        hour: 15,
      },
    ],
  },
  {
    key: 'principal-1',
    register: 'Caja Principal',
    day: 8,
    openHour: 8,
    closeHour: 20,
    openingCents: 200000,
    plan: 'closed',
    floatCents: 80000,
    movements: [
      {
        kind: 'in',
        cents: 25000,
        reason: 'Cambio en monedas del banco',
        hour: 9,
      },
      {
        kind: 'out',
        cents: 12000,
        reason: 'Pago de agua purificada',
        hour: 14,
      },
    ],
  },
  {
    key: 'mostrador-2',
    register: 'Caja Mostrador 2',
    day: 4,
    openHour: 8,
    closeHour: 19,
    openingCents: 100000,
    plan: 'closed',
    movements: [
      { kind: 'in', cents: 15000, reason: 'Fondo extra para cambio', hour: 10 },
    ],
  },
  {
    key: 'express-1',
    register: 'Caja Express',
    day: 1,
    openHour: 8,
    closeHour: 18,
    openingCents: 50000,
    plan: 'submitted',
    movements: [
      { kind: 'out', cents: 6000, reason: 'Propina al repartidor', hour: 14 },
    ],
  },
  {
    key: 'principal-hoy',
    register: 'Caja Principal',
    day: 0,
    openHour: 8,
    openingCents: 80000,
    openingFrom: 'principal-1',
    plan: 'open',
    movements: [
      {
        kind: 'in',
        cents: 30000,
        reason: 'Cambio adicional del banco',
        hour: 9,
      },
      {
        kind: 'out',
        cents: 4500,
        reason: 'Compra de bolsas para despacho',
        hour: 11,
      },
    ],
  },
];

function cashKey(session, step) {
  return `showcase:cash:${session}:${step}`;
}

async function ensureRegisters(ctx, state) {
  const manager = state.tokens.manager;
  state.registers = {};
  let created = 0;
  for (const spec of REGISTERS) {
    let row = await ctx.prisma.cashRegister.findFirst({
      where: { tenantId: ctx.centro.id, name: spec.name },
    });
    if (!row) {
      await call(ctx, manager, 'POST', '/cash-registers', {
        body: { name: spec.name },
        headers: {
          'idempotency-key': cashKey(`register:${spec.name}`, 'create'),
        },
        ok: [201],
      });
      row = await ctx.prisma.cashRegister.findFirstOrThrow({
        where: { tenantId: ctx.centro.id, name: spec.name },
      });
      created += 1;
    }
    state.registers[spec.name] = row;
  }
  return created;
}

async function sessionsOf(ctx, registerId) {
  return ctx.prisma.cashSession.findMany({
    where: { tenantId: ctx.centro.id, registerId },
    orderBy: { openedAt: 'asc' },
  });
}

// Count lines equal to the frozen expected snapshot (+ a deliberate cash delta).
async function countLines(ctx, sessionId, openingCents, cashDelta) {
  const movements = await ctx.prisma.cashMovement.findMany({
    where: { tenantId: ctx.centro.id, sessionId },
  });
  const channels = new Map([['CASH', openingCents]]);
  for (const movement of movements) {
    const key = movement.method === 'CASH' ? 'CASH' : movement.channelKey;
    channels.set(key, (channels.get(key) || 0) + movement.deltaCents);
  }
  channels.set('CASH', channels.get('CASH') + cashDelta);
  return [...channels.entries()].map(([channelKey, amountCents]) => ({
    channelKey,
    amountCents,
  }));
}

async function sessionRow(ctx, sessionId) {
  return ctx.prisma.cashSession.findFirstOrThrow({
    where: { id: sessionId, tenantId: ctx.centro.id },
  });
}

async function openSessionFor(ctx, state, spec, register) {
  const body = { openingCents: spec.openingCents, openingConfirmed: true };
  if (spec.openingFrom) {
    const source = state.sessions[spec.openingFrom];
    const handover = source
      ? await ctx.prisma.cashHandover.findFirst({
          where: {
            tenantId: ctx.centro.id,
            sourceSessionId: source.id,
            kind: 'FLOAT',
            receivedAt: { not: null },
          },
        })
      : null;
    if (handover) {
      body.openingHandoverId = handover.id;
      body.openingCents = handover.receivedCents;
    }
  }
  await call(
    ctx,
    state.tokens.cashier,
    'POST',
    `/cash-registers/${register.id}/sessions`,
    {
      body,
      headers: { 'idempotency-key': cashKey(spec.key, 'open') },
      ok: [201],
    },
  );
  const rows = await sessionsOf(ctx, register.id);
  return rows[rows.length - 1];
}

async function runMovements(ctx, state, spec, sessionId) {
  for (const [index, movement] of (spec.movements || []).entries()) {
    const existing = await ctx.prisma.cashMovement.findFirst({
      where: {
        tenantId: ctx.centro.id,
        sessionId,
        kind: movement.kind === 'in' ? 'CASH_IN' : 'CASH_OUT',
        reason: movement.reason,
      },
    });
    if (existing) continue;
    await call(
      ctx,
      state.tokens.cashier,
      'POST',
      `/cash-sessions/${sessionId}/cash-${movement.kind}`,
      {
        body: { amountCents: movement.cents, reason: movement.reason },
        headers: { 'idempotency-key': cashKey(spec.key, `movement-${index}`) },
        ok: [201],
      },
    );
  }
}

// Advances a session towards its planned end state; every step re-reads the
// database so an interrupted run resumes where it stopped.
async function advanceSession(ctx, state, spec, sessionId) {
  const cashier = state.tokens.cashier;
  const manager = state.tokens.manager;
  let row = await sessionRow(ctx, sessionId);
  if (spec.plan === 'open') return row;

  if (row.status === 'OPEN') {
    await call(
      ctx,
      cashier,
      'POST',
      `/cash-sessions/${sessionId}/start-count`,
      {
        headers: { 'idempotency-key': cashKey(spec.key, 'start-count') },
      },
    );
    row = await sessionRow(ctx, sessionId);
  }
  if (row.status === 'COUNTING') {
    const lines = await countLines(
      ctx,
      sessionId,
      row.openingCents,
      spec.diffCents || 0,
    );
    const body = { lines };
    if (spec.declarationNotes) body.notes = spec.declarationNotes;
    await call(
      ctx,
      cashier,
      'POST',
      `/cash-sessions/${sessionId}/declarations`,
      {
        body,
        headers: { 'idempotency-key': cashKey(spec.key, 'declare') },
        ok: [201],
      },
    );
    row = await sessionRow(ctx, sessionId);
  }
  if (row.status !== 'SUBMITTED') return row;

  const declaration = await ctx.prisma.cashCount.findFirstOrThrow({
    where: { tenantId: ctx.centro.id, sessionId, kind: 'DECLARATION' },
    orderBy: { revision: 'desc' },
  });
  const declaredCash = declaration.linesJson.find(
    (l) => l.channelKey === 'CASH',
  ).amountCents;

  let handovers = await ctx.prisma.cashHandover.findMany({
    where: { tenantId: ctx.centro.id, sourceSessionId: sessionId },
    orderBy: { createdAt: 'asc' },
  });
  if (handovers.length === 0) {
    const floatCents = spec.floatCents || 0;
    await call(ctx, cashier, 'POST', `/cash-sessions/${sessionId}/handovers`, {
      body: {
        handoverKind: 'WITHDRAWAL',
        recipientUserId: state.users.manager,
        declaredCents: declaredCash - floatCents,
        notes:
          spec.plan === 'submitted'
            ? 'Corte del turno: efectivo pendiente de recibir en gerencia.'
            : 'Efectivo del turno entregado a gerencia para depósito.',
      },
      headers: { 'idempotency-key': cashKey(spec.key, 'handover-withdrawal') },
      ok: [201],
    });
    if (floatCents > 0) {
      await call(
        ctx,
        cashier,
        'POST',
        `/cash-sessions/${sessionId}/handovers`,
        {
          body: {
            handoverKind: 'FLOAT',
            recipientUserId: state.users.cashier,
            declaredCents: floatCents,
            notes: 'Fondo de caja que se queda para el siguiente turno.',
          },
          headers: { 'idempotency-key': cashKey(spec.key, 'handover-float') },
          ok: [201],
        },
      );
    }
    handovers = await ctx.prisma.cashHandover.findMany({
      where: { tenantId: ctx.centro.id, sourceSessionId: sessionId },
      orderBy: { createdAt: 'asc' },
    });
  }
  if (spec.plan === 'submitted') return row;

  for (const handover of handovers) {
    if (handover.receivedAt) continue;
    const toManager = handover.recipientUserId === state.users.manager;
    await call(
      ctx,
      toManager ? manager : cashier,
      'POST',
      `/cash-handovers/${handover.id}/receive`,
      {
        body: { receivedCents: handover.declaredCents },
        headers: {
          'idempotency-key': cashKey(spec.key, `receive-${handover.kind}`),
        },
      },
    );
  }
  row = await sessionRow(ctx, sessionId);
  if (!row.drawerReleasedAt) {
    await call(
      ctx,
      cashier,
      'POST',
      `/cash-sessions/${sessionId}/release-drawer`,
      {
        headers: { 'idempotency-key': cashKey(spec.key, 'release') },
      },
    );
  }
  const verified = await ctx.prisma.cashCount.findFirst({
    where: { tenantId: ctx.centro.id, sessionId, kind: 'VERIFICATION' },
  });
  if (!verified) {
    const body = { lines: declaration.linesJson };
    if (spec.diffCents)
      body.notes = 'Conteo verificado en gerencia; coincide con lo declarado.';
    await call(
      ctx,
      manager,
      'POST',
      `/cash-sessions/${sessionId}/verifications`,
      {
        body,
        headers: { 'idempotency-key': cashKey(spec.key, 'verify') },
        ok: [201],
      },
    );
  }
  row = await sessionRow(ctx, sessionId);
  if (row.status !== 'CLOSED') {
    await call(ctx, manager, 'POST', `/cash-sessions/${sessionId}/close`, {
      body: {
        notes: spec.diffCents
          ? 'Cierre con diferencia justificada.'
          : 'Cierre sin diferencias.',
      },
      headers: { 'idempotency-key': cashKey(spec.key, 'close') },
      ok: [201],
    });
  }
  return sessionRow(ctx, sessionId);
}

const addMs = (date, ms) => new Date(date.getTime() + ms);

// Moves the whole session history to its day: session, counts, closing,
// handovers and ledger rows. Skipped for a session still open today.
async function backdateSession(ctx, spec, sessionId) {
  if (spec.day === 0) {
    // Today's session only needs a sensible opening time.
    const opened = pastInstant(ctx, 0, spec.openHour, 5);
    const row = await sessionRow(ctx, sessionId);
    if (
      Math.abs(row.openedAt.getTime() - opened.getTime()) > 30 * 60_000 &&
      row.openedAt > opened
    ) {
      await ctx.prisma.cashSession.update({
        where: { id: sessionId },
        data: { openedAt: opened },
      });
    }
    await backdateLedger(ctx, spec, sessionId);
    return;
  }
  const { prisma } = ctx;
  const row = await sessionRow(ctx, sessionId);
  const opened = pastInstant(ctx, spec.day, spec.openHour, 5);
  if (Math.abs(row.openedAt.getTime() - opened.getTime()) <= TOLERANCE_MS)
    return;
  const closeAt = pastInstant(ctx, spec.day, spec.closeHour, 10);
  const data = { openedAt: opened };
  if (row.frozenAt) data.frozenAt = closeAt;
  if (row.submittedAt) data.submittedAt = addMs(closeAt, 10 * 60_000);
  if (row.drawerReleasedAt) data.drawerReleasedAt = addMs(closeAt, 25 * 60_000);
  if (row.closedAt) data.closedAt = addMs(closeAt, 35 * 60_000);
  await prisma.cashSession.update({ where: { id: sessionId }, data });

  const counts = await prisma.cashCount.findMany({
    where: { tenantId: ctx.centro.id, sessionId },
  });
  for (const count of counts) {
    await prisma.cashCount.update({
      where: { id: count.id },
      data: {
        createdAt: addMs(
          closeAt,
          count.kind === 'DECLARATION' ? 8 * 60_000 : 30 * 60_000,
        ),
      },
    });
  }
  await prisma.cashClosing.updateMany({
    where: { tenantId: ctx.centro.id, sessionId },
    data: { createdAt: addMs(closeAt, 35 * 60_000) },
  });
  const handovers = await prisma.cashHandover.findMany({
    where: { tenantId: ctx.centro.id, sourceSessionId: sessionId },
  });
  for (const handover of handovers) {
    await prisma.cashHandover.update({
      where: { id: handover.id },
      data: {
        createdAt: addMs(closeAt, 12 * 60_000),
        ...(handover.receivedAt
          ? { receivedAt: addMs(closeAt, 20 * 60_000) }
          : {}),
      },
    });
  }

  await backdateLedger(ctx, spec, sessionId);
}

// Ledger rows follow the sale (or the planned hour for manual movements).
async function backdateLedger(ctx, spec, sessionId) {
  const { prisma } = ctx;
  const payments = await prisma.salePayment.findMany({
    where: {
      tenantId: ctx.centro.id,
      id: { in: await movementSourceIds(ctx, sessionId) },
    },
    select: { id: true, saleId: true, createdAt: true },
  });
  const paymentTime = new Map(payments.map((p) => [p.id, p.createdAt]));
  const saleTime = new Map();
  const sales = await prisma.sale.findMany({
    where: {
      tenantId: ctx.centro.id,
      id: { in: payments.map((p) => p.saleId) },
    },
    select: { id: true, confirmedAt: true },
  });
  for (const sale of sales) saleTime.set(sale.id, sale.confirmedAt);
  const movements = await prisma.cashMovement.findMany({
    where: { tenantId: ctx.centro.id, sessionId },
    orderBy: { createdAt: 'asc' },
  });
  for (const movement of movements) {
    let at =
      paymentTime.get(movement.sourceId) || saleTime.get(movement.sourceId);
    if (!at) {
      const planned = (spec.movements || []).find(
        (m) => m.reason === movement.reason,
      );
      at = pastInstant(
        ctx,
        spec.day,
        planned ? planned.hour : spec.openHour + 1,
        20,
      );
    }
    if (Math.abs(movement.occurredAt.getTime() - at.getTime()) < 60_000) {
      continue;
    }
    await prisma.cashMovement.update({
      where: { id: movement.id },
      data: { occurredAt: at, createdAt: at },
    });
  }
}

async function movementSourceIds(ctx, sessionId) {
  const rows = await ctx.prisma.cashMovement.findMany({
    where: { tenantId: ctx.centro.id, sessionId },
    select: { sourceId: true },
  });
  return rows.map((r) => r.sourceId);
}

async function runCash(ctx, state, summary) {
  state.sessions = {};
  summary.registersCreated = await ensureRegisters(ctx, state);
  for (const spec of SESSIONS) {
    const register = state.registers[spec.register];
    const existing = await sessionsOf(ctx, register.id);
    const ordinal = SESSIONS.filter(
      (s) =>
        s.register === spec.register &&
        SESSIONS.indexOf(s) < SESSIONS.indexOf(spec),
    ).length;
    let row = existing[ordinal];
    if (!row) {
      if (!register.isActive) {
        summary.notes.push(`session ${spec.key} skipped: register is inactive`);
        continue;
      }
      row = await openSessionFor(ctx, state, spec, register);
      summary.sessionsCreated += 1;
    }
    state.sessions[spec.key] = { id: row.id, status: row.status };
    for (const sale of SALES.filter((s) => s.session === spec.key)) {
      await processSale(ctx, state, sale, summary);
    }
    await runMovements(ctx, state, spec, row.id);
    row = await advanceSession(ctx, state, spec, row.id);
    state.sessions[spec.key] = { id: row.id, status: row.status };
    await backdateSession(ctx, spec, row.id);
  }
  // Registers meant to be retired are deactivated once their history exists.
  for (const spec of REGISTERS.filter((r) => !r.active)) {
    const register = await ctx.prisma.cashRegister.findFirstOrThrow({
      where: { tenantId: ctx.centro.id, name: spec.name },
    });
    if (register.isActive) {
      await call(
        ctx,
        state.tokens.manager,
        'PATCH',
        `/cash-registers/${register.id}`,
        {
          body: { isActive: false },
          headers: {
            'idempotency-key': cashKey(`register:${spec.name}`, 'deactivate'),
          },
        },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Quotations. The (unique, readable) customer note is the natural key. A
// "converted" quotation does not exist in the domain (no status, no endpoint),
// so it is deliberately not created.
// ---------------------------------------------------------------------------
const QUOTATIONS = [
  {
    notes:
      'Cotización de alimento mensual para criadero: borrador en revisión.',
    customer: 'valeria',
    lines: [
      ['g0', 2],
      ['g3', 1],
    ],
    expiresInDays: 14,
    final: 'DRAFT',
    day: 1,
  },
  {
    notes:
      'Cotización para el refugio Huellitas: alimento y premios, vigente por 15 días.',
    customer: 'carlos',
    lines: [
      ['g1', 4],
      ['g5', 2],
    ],
    expiresInDays: 15,
    final: 'SENT',
    day: 3,
  },
  {
    notes:
      'Cotización de temporada de cachorros: venció sin respuesta del cliente.',
    customer: 'daniela',
    lines: [['g2', 3]],
    expiresInDays: -4,
    final: 'SENT',
    day: 12,
  },
  {
    notes:
      'Cotización de arnés y correas: el cliente decidió esperar al Buen Fin.',
    customer: 'patricia',
    lines: [['g4', 2]],
    expiresInDays: 10,
    final: 'CANCELLED',
    reason: 'CUSTOMER_REQUEST',
    day: 9,
  },
  {
    notes:
      'Cotización de alimento para eventos de adopción: el cliente objetó el precio.',
    customer: 'larga',
    lines: [
      ['g0', 6],
      ['g2', 2],
    ],
    expiresInDays: 5,
    final: 'CANCELLED',
    reason: 'PRICE_OBJECTION',
    day: 6,
  },
  {
    notes:
      'Precios de mayoreo para Veterinaria San Francisco de Asís, sin fecha de vencimiento.',
    customer: 'veterinaria',
    lines: [
      ['g0', 12],
      ['g2', 8],
    ],
    expiresInDays: null,
    final: 'SENT',
    day: 5,
  },
  {
    notes:
      'Cotización con la promoción Semana de la mascota aplicada al producto en oferta.',
    customer: 'ana',
    lines: [
      ['PU', 4],
      ['g1', 2],
    ],
    expiresInDays: 10,
    final: 'SENT',
    day: 2,
    expectPromotion: true,
  },
  {
    notes:
      'Cotización de mostrador para cliente sin registro, válida una semana.',
    customer: null,
    lines: [['g4', 2]],
    expiresInDays: 7,
    final: 'SENT',
    day: 0,
  },
  {
    notes:
      'Borrador con la promoción Semana de la mascota para el festival canino.',
    customer: 'mariana',
    lines: [
      ['PU', 6],
      ['g0', 1],
    ],
    expiresInDays: 20,
    final: 'DRAFT',
    day: 0,
    expectPromotion: true,
  },
];

async function ensureQuotations(ctx, state, summary) {
  const token = state.tokens.manager;
  let created = 0;
  for (const spec of QUOTATIONS) {
    let row = await ctx.prisma.quotation.findFirst({
      where: { tenantId: ctx.centro.id, customerNotes: spec.notes },
    });
    if (!row) {
      const draft = await call(ctx, token, 'POST', '/quotations/drafts', {
        body: spec.customer
          ? { customerId: state.customers[spec.customer].id }
          : {},
        ok: [201],
      });
      for (const [source, quantity] of spec.lines) {
        await call(ctx, token, 'POST', `/quotations/drafts/${draft.id}/items`, {
          body: { productId: lineProduct(state, source).id, quantity },
          ok: [200, 201],
        });
      }
      await call(ctx, token, 'PATCH', `/quotations/drafts/${draft.id}/notes`, {
        body: { customerNotes: spec.notes },
      });
      row = await ctx.prisma.quotation.findFirstOrThrow({
        where: { id: draft.id, tenantId: ctx.centro.id },
      });
      created += 1;
    }
    if (row.status === 'DRAFT') {
      const expiresAt =
        spec.expiresInDays === null
          ? null
          : new Date(
              ctx.today.getTime() + spec.expiresInDays * DAY_MS,
            ).toISOString();
      await call(ctx, token, 'PATCH', `/quotations/drafts/${row.id}/expiry`, {
        body: { expiresAt },
      });
      if (spec.final === 'SENT') {
        await call(
          ctx,
          token,
          'POST',
          `/quotations/drafts/${row.id}/send?email=false`,
          {},
        );
      } else if (spec.final === 'CANCELLED') {
        await call(ctx, token, 'POST', `/quotations/drafts/${row.id}/cancel`, {
          body: { cancelReason: spec.reason },
        });
      }
      row = await ctx.prisma.quotation.findFirstOrThrow({
        where: { id: row.id, tenantId: ctx.centro.id },
      });
    }
    const promoted = spec.expectPromotion
      ? await ctx.prisma.quotationItem.count({
          where: { quotationId: row.id, promotionId: { not: null } },
        })
      : 1;
    if (promoted === 0) {
      summary.notes.push(
        `quotation "${spec.notes.slice(0, 40)}…" has no promotion applied`,
      );
    }
    // Quotations are stamped "now" by the API; spread them over the last weeks.
    const createdAt = pastInstant(ctx, spec.day, 10, 15);
    if (
      Math.abs(row.createdAt.getTime() - createdAt.getTime()) > TOLERANCE_MS
    ) {
      await ctx.prisma.quotation.update({
        where: { id: row.id },
        data: {
          createdAt,
          ...(row.canceledAt
            ? { canceledAt: addMs(createdAt, 26 * 3_600_000) }
            : {}),
        },
      });
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function run(ctx) {
  const summary = {
    notes: [],
    salesCreated: 0,
    sessionsCreated: 0,
  };
  const state = { saleIds: {}, sessions: {} };

  summary.roleGrantsAdded = await ensureRoleGrants(ctx);
  await resolveActors(ctx, state);
  summary.productPool = await pickProducts(ctx, state);
  assignRoles(state);
  Object.assign(summary, { customers: await ensureCustomers(ctx, state) });
  Object.assign(summary, { promotions: await ensurePromotions(ctx, state) });

  // Cash sessions first: their sales must be charged while the session is open.
  await runCash(ctx, state, summary);
  for (const sale of SALES.filter((s) => !s.session)) {
    await processSale(ctx, state, sale, summary);
  }
  summary.quotationsCreated = await ensureQuotations(ctx, state, summary);
  summary.unsupported = [
    'quotation "convertida": the domain has no converted status or endpoint',
    'sale deliveryStatus SHIPPED / NOT_APPLICABLE: set only by delivery-route/bot flows (ops module)',
    'refund settlement via API: POST /sales/refunds/:id/settlements parses the cuid refund id as a UUID (HTTP 400); settlements are written directly',
  ];
  return summary;
}

module.exports = {
  name: 'commerce',
  run,
  _internals: {
    SALES,
    SESSIONS,
    QUOTATIONS,
    REGISTERS,
    ROLE_GRANTS,
    CUSTOMERS,
  },
};
