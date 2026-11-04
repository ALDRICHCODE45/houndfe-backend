// Dev showcase › catalog: categories, brands, price lists, 38 products for
// Sucursal Centro (stock/lot/variant/service/image/long-name cases), one
// product with a >30-movement kardex and the public-catalog states.
//
// Stock only moves through the inventory journal: products are created through
// POST /products (INITIAL movements), the rest through POST /inventory/adjustments
// and a real sale charge/cancel. Idempotent: products match by (tenant, name),
// adjustments by their unique note, the sale by its SALE movement.
//
// The ONE direct-Prisma write is the legacy base of the kardex product: its
// OPENING movements reproduce what the O1 migration wrote for pre-journal stock
// (the API cannot create OPENING). Everything after that goes through the API.
'use strict';

const { randomUUID } = require('node:crypto');

const MANAGER = 'manager@houndfe.com';
const ADMIN = 'admin@houndfe.com';

const HERO_NAME = 'Alimento Premium para Perro Adulto 15 kg';
const LEGACY_LOT = 'PP-2509';
const SALE_CUSTOMER = {
  firstName: 'Rosa Elena',
  lastName: 'Vázquez Montes',
  email: 'rosa.vazquez@correo.mx',
  phoneCountryCode: '+52',
  phone: '5528814470',
  addresses: [
    {
      street: 'Calle Tonalá',
      exteriorNumber: '187',
      interiorNumber: '4',
      zipCode: '06700',
      neighborhood: 'Roma Norte',
      municipality: 'Cuauhtémoc',
      city: 'Ciudad de México',
      state: 'Ciudad de México',
    },
  ],
};

const CATEGORIES = [
  'Alimento para perro',
  'Alimento para gato',
  'Accesorios y correas',
  'Higiene y cuidado',
  'Juguetes',
  'Acuario',
  'Salud y farmacia',
  'Servicios',
];
const EXTRA_PRICE_LISTS = ['Veterinarias', 'Empleados'];

const peso = (amount) => Math.round(amount * 100);

/** YYYY-MM-DD of the business day (tz) shifted by `offset` days. */
function businessDate(today, tz, offset = 0) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(today);
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

const PALETTE = {
  'Alimento para perro': 'b45309',
  'Alimento para gato': '7c3aed',
  'Accesorios y correas': '0f766e',
  'Higiene y cuidado': '0284c7',
  Juguetes: 'be185d',
  Acuario: '0e7490',
  'Salud y farmacia': '15803d',
  Servicios: '475569',
};
const imageUrl = (label, category) =>
  `https://placehold.co/600x600/${PALETTE[category]}/ffffff.png?text=${encodeURIComponent(label)}`;

// ── Product catalogue ──────────────────────────────────────────────────────
// stock: { qty, min }  |  lots: [{ no, qty, days }] (days from today)  |
// variants: [{ name, qty, min }]  |  service: { unit, capacity, notes }
// img: short label → product has an image; omitted → no image.
const PRODUCTS = [
  {
    name: HERO_NAME,
    cat: 'Alimento para perro',
    brand: 'Pro Plan',
    price: 1249,
    cost: 820,
    sku: 'PP-AD-15',
    barcode: '7501072300158',
    iva: 'IVA_0',
    min: 15,
    img: 'Pro Plan 15 kg',
    description:
      'Alimento seco completo para perros adultos de raza mediana y grande. Con pollo y arroz.',
    mayoreo: 1139,
    hero: true,
  },
  {
    name: 'Alimento para Cachorro Raza Mediana 3 kg',
    cat: 'Alimento para perro',
    brand: 'Royal Canin',
    price: 489,
    cost: 330,
    sku: 'RC-CAC-3',
    iva: 'IVA_0',
    stock: { qty: 48, min: 8 },
    img: 'Royal Canin Cachorro',
    mayoreo: 449,
  },
  {
    name: 'Croquetas Adulto Res y Pollo 20 kg',
    cat: 'Alimento para perro',
    brand: 'Pedigree',
    price: 789,
    cost: 540,
    sku: 'PED-AD-20',
    iva: 'IVA_0',
    stock: { qty: 35, min: 10 },
    img: 'Pedigree 20 kg',
    mayoreo: 729,
    vet: 699,
    tiers: [
      { minQuantity: 5, price: 749 },
      { minQuantity: 10, price: 719 },
    ],
  },
  {
    name: 'Alimento Húmedo Pollo y Arroz Lata 360 g',
    cat: 'Alimento para perro',
    brand: "Hill's",
    price: 62,
    cost: 38,
    iva: 'IVA_0',
    stock: { qty: 4, min: 12 },
  },
  {
    name: 'Premios de Entrenamiento Mini Hígado 200 g',
    cat: 'Alimento para perro',
    brand: 'Pedigree',
    price: 79,
    cost: 44,
    iva: 'IVA_0',
    stock: { qty: 33, min: 10 },
    img: 'Premios Hígado',
  },
  {
    name: 'Snacks Dentales para Perro Mediano (descontinuado)',
    cat: 'Alimento para perro',
    brand: 'Pedigree',
    price: 129,
    cost: 76,
    iva: 'IVA_0',
    stock: { qty: 15, min: 5 },
    notForSale: true,
  },
  {
    name: 'Croquetas Naturales Sin Grano de Salmón y Camote para Perros Adultos de Raza Grande 18 kg Familiar',
    cat: 'Alimento para perro',
    brand: 'Taste of the Wild',
    price: 1599,
    cost: 1090,
    iva: 'IVA_0',
    stock: { qty: 11, min: 4 },
    img: 'Salmón y Camote',
    description:
      'Fórmula sin granos con salmón, camote y probióticos. Presentación familiar de 18 kg.',
  },
  {
    name: 'Alimento para Gato Adulto Salmón 7.5 kg',
    cat: 'Alimento para gato',
    brand: 'Whiskas',
    price: 659,
    cost: 450,
    sku: 'WH-GAD-75',
    iva: 'IVA_0',
    stock: { qty: 22, min: 6 },
    img: 'Whiskas Salmón',
    mayoreo: 609,
  },
  {
    name: 'Alimento Esterilizado para Gato 2 kg',
    cat: 'Alimento para gato',
    brand: "Hill's",
    price: 389,
    cost: 260,
    iva: 'IVA_0',
    stock: { qty: 0, min: 5 },
    img: 'Esterilizado 2 kg',
  },
  {
    name: 'Paté de Atún para Gatitos 85 g',
    cat: 'Alimento para gato',
    brand: 'Felix',
    price: 24,
    cost: 14,
    iva: 'IVA_0',
    stock: { qty: 6, min: 10 },
  },
  {
    name: 'Arena Sanitaria Aglomerante 10 kg',
    cat: 'Alimento para gato',
    brand: 'Sin Marca',
    price: 189,
    cost: 118,
    sku: 'ARE-AGL-10',
    stock: { qty: 60, min: 15 },
    img: 'Arena 10 kg',
    mayoreo: 169,
  },
  {
    name: 'Collar Ajustable de Nailon',
    cat: 'Accesorios y correas',
    brand: 'Trixie',
    price: 149,
    cost: 72,
    img: 'Collar Nailon',
    description:
      'Collar ajustable con broche de seguridad, disponible en varias tallas y colores.',
    variants: [
      { name: 'Chico · Azul', qty: 15, min: 3 },
      { name: 'Mediano · Rojo', qty: 9, min: 3 },
      { name: 'Grande · Negro', qty: 0, min: 3 },
      { name: 'Extra grande · Verde', qty: 5, min: 2 },
    ],
    removeVariant: 'Extra grande · Verde',
    variantAdjustments: [
      {
        variant: 'Chico · Azul',
        delta: -2,
        reason: 'DAMAGE',
        note: 'Dos collares con broche defectuoso devueltos al proveedor',
      },
      {
        variant: 'Mediano · Rojo',
        delta: 3,
        reason: 'PHYSICAL_COUNT',
        note: 'Conteo mensual: se encontraron 3 piezas en bodega',
      },
      {
        variant: 'Chico · Azul',
        delta: -1,
        reason: 'OTHER',
        note: 'Pieza usada como muestra en el aparador',
      },
    ],
  },
  {
    name: 'Arnés Acolchado para Paseo',
    cat: 'Accesorios y correas',
    brand: 'Julius-K9',
    price: 389,
    cost: 215,
    img: 'Arnés Acolchado',
    variants: [
      { name: 'Chico', qty: 8, min: 3 },
      { name: 'Mediano', qty: 12, min: 3 },
      { name: 'Grande', qty: 3, min: 4 },
    ],
  },
  {
    name: 'Impermeable para Perro Talla M',
    cat: 'Accesorios y correas',
    brand: 'Ruffwear',
    price: 329,
    cost: 180,
    variants: [
      { name: 'Amarillo', qty: 0, min: 2 },
      { name: 'Azul marino', qty: 0, min: 2 },
    ],
  },
  {
    name: 'Correa Retráctil 5 m',
    cat: 'Accesorios y correas',
    brand: 'Flexi',
    price: 279,
    cost: 160,
    sku: 'FLX-RET-5',
    stock: { qty: 14, min: 4 },
    img: 'Correa Retráctil',
  },
  {
    name: 'Placa de Identificación Grabada con Nombre',
    cat: 'Accesorios y correas',
    brand: 'Sin Marca',
    price: 120,
    cost: 35,
    sku: 'PLACA-GRAB',
    noStock: true,
    description:
      'Placa de acero con nombre y teléfono, grabada al momento. No lleva control de inventario.',
  },
  {
    name: 'Cama Ortopédica Mediana Gris',
    cat: 'Accesorios y correas',
    brand: 'Furhaven',
    price: 899,
    cost: 540,
    stock: { qty: 7, min: 2 },
    img: 'Cama Ortopédica',
    hidePrice: true,
  },
  {
    name: 'Transportadora Rígida para Gato y Perro Chico',
    cat: 'Accesorios y correas',
    brand: 'Petmate',
    price: 549,
    cost: 330,
    stock: { qty: 9, min: 3 },
    img: 'Transportadora',
  },
  {
    name: 'Bebedero Fuente de Cerámica',
    cat: 'Accesorios y correas',
    brand: 'Catit',
    price: 459,
    cost: 270,
    stock: { qty: 5, min: 2 },
  },
  {
    name: 'Pelota de Goma Resistente',
    cat: 'Juguetes',
    brand: 'Kong',
    price: 169,
    cost: 90,
    stock: { qty: 40, min: 8 },
    img: 'Pelota Kong',
    mayoreo: 149,
  },
  {
    name: 'Hueso de Nailon Sabor Pollo',
    cat: 'Juguetes',
    brand: 'Nylabone',
    price: 139,
    cost: 74,
    stock: { qty: 25, min: 6 },
    img: 'Hueso Nylabone',
  },
  {
    name: 'Rascador de Sisal Torre 80 cm',
    cat: 'Juguetes',
    brand: 'Petmate',
    price: 649,
    cost: 380,
    stock: { qty: 2, min: 3 },
    img: 'Rascador Sisal',
  },
  {
    name: 'Juguete de Cuerda Algodón 3 Nudos',
    cat: 'Juguetes',
    brand: 'Chuckit!',
    price: 59,
    cost: 28,
    stock: { qty: 0, min: 6 },
    notForSale: true,
  },
  {
    name: 'Shampoo Hipoalergénico 500 ml',
    cat: 'Higiene y cuidado',
    brand: 'Bio-Groom',
    price: 219,
    cost: 130,
    sku: 'BG-SHA-500',
    stock: { qty: 18, min: 5 },
    img: 'Shampoo 500 ml',
    vet: 189,
  },
  {
    name: 'Cepillo Deslanador para Perro y Gato',
    cat: 'Higiene y cuidado',
    brand: 'FURminator',
    price: 349,
    cost: 205,
    stock: { qty: 11, min: 3 },
    img: 'Deslanador',
  },
  {
    name: 'Peine Antipulgas Metálico',
    cat: 'Higiene y cuidado',
    brand: 'Safari',
    price: 69,
    cost: 31,
    stock: { qty: 20, min: 5 },
  },
  {
    name: 'Toallitas Húmedas para Mascotas 80 piezas',
    cat: 'Higiene y cuidado',
    brand: 'Petkin',
    price: 119,
    cost: 66,
    stock: { qty: 0, min: 6 },
    img: 'Toallitas 80 pzas',
  },
  {
    name: 'Antipulgas y Garrapatas para Perro Mediano',
    cat: 'Salud y farmacia',
    brand: 'Frontline',
    price: 389,
    cost: 245,
    sku: 'FRN-PM',
    min: 8,
    lots: [
      { no: 'FRN-2601', qty: 14, days: 5 },
      { no: 'FRN-2704', qty: 20, days: 260 },
    ],
    img: 'Frontline Plus',
    vet: 329,
  },
  {
    name: 'Desparasitante Oral Canino 10 ml',
    cat: 'Salud y farmacia',
    brand: 'Sin Marca',
    price: 189,
    cost: 105,
    min: 5,
    lots: [
      { no: 'DES-2509', qty: 6, days: -12 },
      { no: 'DES-2612', qty: 18, days: 150 },
    ],
  },
  {
    name: 'Multivitamínico para Gato 60 Tabletas',
    cat: 'Salud y farmacia',
    brand: 'Sin Marca',
    price: 229,
    cost: 130,
    min: 6,
    lots: [{ no: 'VIT-2706', qty: 25, days: 210 }],
    img: 'Multivitamínico Gato',
  },
  {
    name: 'Antibiótico Veterinario Amoxicilina 250 mg',
    cat: 'Salud y farmacia',
    brand: 'Sin Marca',
    price: 245,
    cost: 150,
    stock: { qty: 12, min: 4 },
    prescription: true,
    description: 'Venta con receta médica veterinaria.',
  },
  {
    name: 'Kit de Primeros Auxilios para Mascotas',
    cat: 'Salud y farmacia',
    brand: 'Sin Marca',
    price: 299,
    cost: 170,
    stock: { qty: 8, min: 3 },
  },
  {
    name: 'Pecera Acuario 40 L con Filtro',
    cat: 'Acuario',
    brand: 'AquaClear',
    price: 1190,
    cost: 760,
    stock: { qty: 5, min: 2 },
    img: 'Pecera 40 L',
  },
  {
    name: 'Alimento para Peces Tropicales 100 g',
    cat: 'Acuario',
    brand: 'Tetra',
    price: 89,
    cost: 48,
    stock: { qty: 30, min: 8 },
    img: 'Tetra 100 g',
  },
  {
    name: 'Acondicionador de Agua 250 ml',
    cat: 'Acuario',
    brand: 'Tetra',
    price: 129,
    cost: 72,
    stock: { qty: 3, min: 6 },
  },
  {
    name: 'Baño y Corte Higiénico (Perro Mediano)',
    cat: 'Servicios',
    price: 350,
    img: 'Baño y Corte',
    service: {
      unit: 'SESION',
      capacity: 4,
      notes:
        'Incluye baño, secado, corte higiénico y limpieza de oídos. Duración aproximada: 90 minutos.',
    },
  },
  {
    name: 'Consulta Veterinaria General',
    cat: 'Servicios',
    price: 450,
    service: {
      unit: 'CONSULTA',
      capacity: 1,
      notes: 'Revisión general, peso y plan de vacunación.',
    },
  },
  {
    name: 'Paseo de Perros (1 hora)',
    cat: 'Servicios',
    price: 120,
    img: 'Paseo de Perros',
    service: {
      unit: 'HORA',
      capacity: 6,
      notes: 'Grupos pequeños en el parque, de lunes a sábado.',
    },
  },
];

// Lots of the kardex product. The legacy lot is created as pre-journal stock
// (OPENING); the other two come through the lots endpoint (INITIAL).
const HERO_LOTS = {
  expired: { no: LEGACY_LOT, days: -20 },
  near: { no: 'PP-2611', qty: 9, days: 4 },
  valid: { no: 'PP-2705', qty: 40, days: 200 },
};
const HERO_LEGACY = { untracked: 10, lot: 12 };
const HERO_SALE_QTY = 14; // 9 from the near lot + 5 from the valid lot (FEFO)

// bucket: 'U' untracked | 'EXP' expired lot | 'NEAR' | 'VAL'
const HERO_ADJUSTMENTS = [
  [
    'U',
    2,
    'PHYSICAL_COUNT',
    'Conteo de apertura: aparecieron 2 bolsas sin registrar',
  ],
  ['VAL', -2, 'DAMAGE', 'Dos bolsas rotas al descargar el camión'],
  ['EXP', -3, 'EXPIRED', 'Bolsas caducadas retiradas del anaquel'],
  [
    'U',
    -1,
    'THEFT_LOSS',
    'Faltante detectado en conteo cíclico; se levantó acta interna',
  ],
  [
    'VAL',
    2,
    'DATA_ENTRY_CORRECTION',
    'Corrección de captura: la remisión traía 42 y se registraron 40',
  ],
  [
    'VAL',
    -2,
    'OTHER',
    'Muestras entregadas a la veterinaria aliada para promoción',
  ],
  ['U', -2, 'DAMAGE', 'Bolsa mordida por roedor en bodega'],
  ['EXP', -2, 'EXPIRED', 'Segundo retiro de producto caducado'],
  ['VAL', 4, 'PHYSICAL_COUNT', 'Conteo semanal: sobrante en tarima 3'],
  [
    'U',
    1,
    'DATA_ENTRY_CORRECTION',
    'Se había restado de más en una salida manual',
  ],
  ['VAL', -1, 'THEFT_LOSS', 'Faltante en tarima 3 tras el cierre de turno'],
  ['EXP', -1, 'OTHER', 'Producto caducado donado al refugio municipal'],
  'SALE',
  ['NEAR', -2, 'DAMAGE', 'Bolsas húmedas por goteo en el techo'],
  ['VAL', 6, 'PHYSICAL_COUNT', 'Conteo de cierre de mes: diferencia a favor'],
  ['U', -1, 'THEFT_LOSS', 'Bolsa faltante tras revisión de cámaras'],
  ['EXP', -1, 'EXPIRED', 'Tercer retiro de producto caducado'],
  ['VAL', -3, 'DAMAGE', 'Empaque dañado en traslado entre sucursales'],
  [
    'NEAR',
    1,
    'DATA_ENTRY_CORRECTION',
    'Corrección: la remisión del lote traía 10 piezas',
  ],
  ['U', 3, 'PHYSICAL_COUNT', 'Reconteo de exhibición en piso de venta'],
  [
    'VAL',
    -2,
    'OTHER',
    'Producto usado como demostración en evento de adopción',
  ],
  ['EXP', -1, 'DAMAGE', 'Bolsa del lote caducado se rompió al retirarla'],
  [
    'NEAR',
    -1,
    'OTHER',
    'Muestra abierta para prueba de palatabilidad con clientes',
  ],
  [
    'VAL',
    3,
    'DATA_ENTRY_CORRECTION',
    'Ajuste por captura duplicada en una devolución',
  ],
  ['U', -2, 'PHYSICAL_COUNT', 'Conteo final del mes'],
  ['VAL', -1, 'PHYSICAL_COUNT', 'Conteo de cierre: una bolsa menos en tarima'],
  ['U', 1, 'DAMAGE', 'Bolsa recuperada de la merma tras revisión'],
];

class StepError extends Error {}

function expectStatus(res, wanted, label) {
  const ok = Array.isArray(wanted)
    ? wanted.includes(res.status)
    : res.status === wanted;
  if (!ok) {
    const detail =
      typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    throw new StepError(
      `${label}: HTTP ${res.status} ${String(detail).slice(0, 300)}`,
    );
  }
  return res.body;
}

// ── Reference data ─────────────────────────────────────────────────────────

async function ensureNamed(api, token, route, names) {
  const listed = expectStatus(
    await api.http('GET', route, { token }),
    200,
    `GET ${route}`,
  );
  const byName = new Map(listed.map((row) => [row.name.toLowerCase(), row.id]));
  const result = new Map();
  for (const name of names) {
    let id = byName.get(name.toLowerCase());
    if (!id) {
      const created = expectStatus(
        await api.http('POST', route, { token, body: { name } }),
        201,
        `create ${route} ${name}`,
      );
      id = created.id;
    }
    result.set(name, id);
  }
  return result;
}

// ── Products ───────────────────────────────────────────────────────────────

function priceListsFor(spec, ids) {
  const entries = [];
  if (spec.mayoreo) {
    entries.push({
      priceListId: ids.get('Mayoreo'),
      priceCents: peso(spec.mayoreo),
    });
  }
  if (spec.vet) {
    entries.push({
      priceListId: ids.get('Veterinarias'),
      priceCents: peso(spec.vet),
      tierPrices: (spec.tiers ?? []).map((tier) => ({
        minQuantity: tier.minQuantity,
        priceCents: peso(tier.price),
      })),
    });
  } else if (spec.tiers) {
    entries.push({
      priceListId: ids.get('Mayoreo'),
      priceCents: peso(spec.mayoreo ?? spec.price),
      tierPrices: spec.tiers.map((tier) => ({
        minQuantity: tier.minQuantity,
        priceCents: peso(tier.price),
      })),
    });
  }
  return entries;
}

function productBody(spec, refs, today, tz) {
  const body = {
    name: spec.name,
    categoryId: refs.categories.get(spec.cat),
    priceCents: peso(spec.price),
    ivaRate: spec.iva ?? 'IVA_16',
    sellInPos: !spec.notForSale,
    includeInOnlineCatalog: !spec.notForSale,
  };
  if (spec.description) body.description = spec.description;
  if (spec.hidePrice) body.hidePriceInOnlineCatalog = true;
  if (spec.img) {
    body.images = [{ url: imageUrl(spec.img, spec.cat), isMain: true }];
  }
  const priceLists = priceListsFor(spec, refs.priceLists);
  if (priceLists.length) body.priceLists = priceLists;

  if (spec.service) {
    body.type = 'SERVICE';
    body.unit = spec.service.unit;
    body.serviceDetail = {
      capacity: spec.service.capacity,
      notes: spec.service.notes,
    };
    return body;
  }

  body.brandId = refs.brands.get(spec.brand);
  body.purchaseCost = { mode: 'NET', valueCents: peso(spec.cost) };
  if (spec.sku) body.sku = spec.sku;
  if (spec.barcode) body.barcode = spec.barcode;
  if (spec.prescription) body.requiresPrescription = true;

  if (spec.noStock) {
    body.useStock = false;
  } else if (spec.variants) {
    body.useStock = true;
    body.hasVariants = true;
    body.variants = spec.variants.map((variant) => ({
      name: variant.name,
      quantity: variant.qty,
      minQuantity: variant.min,
    }));
  } else if (spec.lots || spec.hero) {
    body.useStock = true;
    body.useLotsAndExpirations = true;
    body.minQuantity = spec.min;
    // The kardex product starts empty: its legacy stock is set up separately.
    body.lots = (spec.lots ?? []).map((lot) => ({
      lotNumber: lot.no,
      quantity: lot.qty,
      expirationDate: businessDate(today, tz, lot.days),
    }));
  } else {
    body.useStock = true;
    body.quantity = spec.stock.qty;
    body.minQuantity = spec.stock.min;
  }
  return body;
}

/** Keeps relative lot expirations fresh on re-runs (dates only move when they change). */
async function refreshLots(ctx, token, productId, lots) {
  const { api, prisma, centro, today, tz } = ctx;
  let moved = 0;
  for (const lot of lots) {
    const row = await prisma.lot.findFirst({
      where: { tenantId: centro.id, productId, lotNumber: lot.no },
    });
    if (!row) continue;
    const wanted = businessDate(today, tz, lot.days);
    if (row.expirationDate.toISOString().slice(0, 10) === wanted) continue;
    expectStatus(
      await api.http('PATCH', `/products/${productId}/lots/${row.id}`, {
        token,
        body: { expirationDate: wanted },
      }),
      200,
      `refresh lot ${lot.no}`,
    );
    moved += 1;
  }
  return moved;
}

async function ensureProduct(ctx, token, refs, spec) {
  const { api, prisma, centro, today, tz } = ctx;
  const existing = await prisma.product.findFirst({
    where: { tenantId: centro.id, name: spec.name },
    select: { id: true },
  });
  if (existing) {
    const lots = spec.lots ?? (spec.hero ? Object.values(HERO_LOTS) : []);
    await refreshLots(ctx, token, existing.id, lots);
    return { id: existing.id, created: false };
  }
  if (spec.name.length > 100)
    throw new StepError(`name too long: ${spec.name}`);
  const created = expectStatus(
    await api.http('POST', '/products', {
      token,
      body: productBody(spec, refs, today, tz),
    }),
    201,
    `create product ${spec.name}`,
  );
  return { id: created.id, created: true };
}

// ── Inventory journal helpers ──────────────────────────────────────────────

const stockOf = async (api, token, productId) =>
  expectStatus(
    await api.http('GET', `/inventory/products/${productId}/stock`, { token }),
    200,
    `stock ${productId}`,
  );

/** One adjustment unless a movement carrying `note` already exists for the product. */
async function adjustOnce(ctx, token, productId, target, delta, reason, note) {
  const { api, prisma, centro } = ctx;
  const done = await prisma.stockMovement.findFirst({
    where: { tenantId: centro.id, productId, type: 'ADJUSTMENT', note },
    select: { id: true },
  });
  if (done) return false;
  const snapshot = await stockOf(api, token, productId);
  let version;
  let quantity;
  const ref = { productId };
  if (target.lotId) {
    const lot = snapshot.lots.find((row) => row.id === target.lotId);
    ({ version, quantity } = lot);
    ref.lotId = lot.id;
  } else if (target.variantId) {
    const variant = snapshot.variants.find(
      (row) => row.id === target.variantId,
    );
    ({ version, quantity } = variant);
    ref.variantId = variant.id;
  } else {
    ({ quantity, version } = snapshot.product.untracked);
  }
  if (quantity + delta < 0) {
    throw new StepError(`adjustment "${note}" would leave a negative balance`);
  }
  expectStatus(
    await api.http('POST', '/inventory/adjustments', {
      token,
      headers: {
        'idempotency-key': `showcase-${productId}-${Buffer.from(note).toString('base64url').slice(0, 60)}`,
      },
      body: { target: ref, expectedVersion: version, delta, reason, note },
    }),
    [200, 201],
    `adjust "${note}"`,
  );
  return true;
}

// ── Kardex product (legacy OPENING + INITIAL + every reason + FEFO sale) ───

async function ensureLegacyBase(ctx, productId) {
  const { prisma, centro, today, tz } = ctx;
  const journaled = await prisma.stockMovement.count({
    where: { tenantId: centro.id, productId },
  });
  const lots = await prisma.lot.count({
    where: { tenantId: centro.id, productId },
  });
  if (journaled > 0 || lots > 0) return false;

  const product = await prisma.product.findFirstOrThrow({
    where: { id: productId, tenantId: centro.id },
  });
  const total = HERO_LEGACY.untracked + HERO_LEGACY.lot;
  const now = Date.now();
  await prisma.$transaction(async (tx) => {
    const lot = await tx.lot.create({
      data: {
        tenantId: centro.id,
        productId,
        lotNumber: LEGACY_LOT,
        quantity: HERO_LEGACY.lot,
        manufactureDate: new Date(
          `${businessDate(today, tz, -380)}T00:00:00.000Z`,
        ),
        expirationDate: new Date(
          `${businessDate(today, tz, HERO_LOTS.expired.days)}T00:00:00.000Z`,
        ),
      },
    });
    await tx.product.update({
      where: { id: product.id },
      data: { quantity: total },
    });
    const base = {
      tenantId: centro.id,
      productId,
      productName: product.name,
      type: 'OPENING',
      groupType: 'PRODUCT',
      groupId: productId,
      actorId: null,
      actorDisplayName: 'Sistema',
    };
    // Same shape as the O1 migration: untracked first, then lots, consecutive ms.
    await tx.stockMovement.create({
      data: {
        ...base,
        id: randomUUID(),
        bucketKind: 'PRODUCT_UNTRACKED',
        delta: HERO_LEGACY.untracked,
        balanceAfter: HERO_LEGACY.untracked,
        productBalanceAfter: HERO_LEGACY.untracked,
        createdAt: new Date(now - 1),
      },
    });
    await tx.stockMovement.create({
      data: {
        ...base,
        id: randomUUID(),
        bucketKind: 'LOT',
        lotId: lot.id,
        lotNumber: LEGACY_LOT,
        delta: HERO_LEGACY.lot,
        balanceAfter: HERO_LEGACY.lot,
        productBalanceAfter: total,
        createdAt: new Date(now),
      },
    });
  });
  return true;
}

async function ensureCustomer(ctx, token) {
  const { api, prisma, centro } = ctx;
  let customer = await prisma.customer.findFirst({
    where: { tenantId: centro.id, email: SALE_CUSTOMER.email },
  });
  if (!customer) {
    expectStatus(
      await api.http('POST', '/customers', { token, body: SALE_CUSTOMER }),
      201,
      'create customer',
    );
    customer = await prisma.customer.findFirstOrThrow({
      where: { tenantId: centro.id, email: SALE_CUSTOMER.email },
    });
  }
  const address = await prisma.customerAddress.findFirstOrThrow({
    where: { tenantId: centro.id, customerId: customer.id },
  });
  return { customerId: customer.id, addressId: address.id };
}

/** FEFO sale split across two lots, then its cancellation (only delivery sales can be cancelled). */
async function ensureHeroSale(ctx, token, productId) {
  const { api, prisma, centro } = ctx;
  let sale = await prisma.stockMovement.findFirst({
    where: { tenantId: centro.id, productId, type: 'SALE' },
    select: { groupId: true },
  });
  if (!sale) {
    const { customerId, addressId } = await ensureCustomer(ctx, token);
    const manager = await prisma.user.findUniqueOrThrow({
      where: { email: MANAGER },
    });
    const leftover = await prisma.sale.findFirst({
      where: {
        tenantId: centro.id,
        status: 'DRAFT',
        userId: manager.id,
        items: { some: { productId } },
      },
      select: { id: true },
    });
    const draftId =
      leftover?.id ??
      expectStatus(
        await api.http('POST', '/sales/drafts', { token }),
        201,
        'open draft',
      ).id;
    if (!leftover) {
      expectStatus(
        await api.http('POST', `/sales/drafts/${draftId}/items`, {
          token,
          body: { productId, quantity: HERO_SALE_QTY },
        }),
        200,
        'add sale item',
      );
      expectStatus(
        await api.http('PUT', `/sales/drafts/${draftId}/customer`, {
          token,
          body: { customerId, shippingAddressId: addressId },
        }),
        200,
        'assign customer',
      );
    }
    const drafts = expectStatus(
      await api.http('GET', '/sales/drafts', { token }),
      200,
      'read drafts',
    );
    const total = drafts.find((row) => row.id === draftId)?.totalCents;
    if (!Number.isInteger(total)) throw new StepError('draft total not found');
    expectStatus(
      await api.http('POST', `/sales/drafts/${draftId}/charge`, {
        token,
        headers: { 'idempotency-key': `showcase-charge-${draftId}` },
        body: {
          payments: [{ method: 'cash', amountCents: total }],
          delivery: true,
        },
      }),
      [200, 201],
      'charge sale',
    );
    sale = { groupId: draftId };
  }
  const restored = await prisma.stockMovement.count({
    where: { tenantId: centro.id, productId, type: 'SALE_CANCELLATION' },
  });
  if (restored === 0) {
    expectStatus(
      await api.http('POST', `/sales/${sale.groupId}/cancel`, {
        token,
        body: { reason: 'CUSTOMER_REQUEST' },
      }),
      200,
      'cancel sale',
    );
  }
  return sale.groupId;
}

async function runHero(ctx, token, productId) {
  const { api, today, tz } = ctx;
  const summary = { adjustments: 0 };
  summary.legacyBase = await ensureLegacyBase(ctx, productId);

  for (const lot of [HERO_LOTS.near, HERO_LOTS.valid]) {
    const snapshot = await stockOf(api, token, productId);
    if (snapshot.lots.some((row) => row.lotNumber === lot.no)) continue;
    expectStatus(
      await api.http('POST', `/products/${productId}/lots`, {
        token,
        body: {
          lotNumber: lot.no,
          quantity: lot.qty,
          expirationDate: businessDate(today, tz, lot.days),
        },
      }),
      201,
      `add lot ${lot.no}`,
    );
  }
  await refreshLots(ctx, token, productId, Object.values(HERO_LOTS));

  const idOf = async (key) => {
    if (key === 'U') return {};
    const wanted = {
      EXP: HERO_LOTS.expired,
      NEAR: HERO_LOTS.near,
      VAL: HERO_LOTS.valid,
    }[key].no;
    const snapshot = await stockOf(api, token, productId);
    return { lotId: snapshot.lots.find((row) => row.lotNumber === wanted).id };
  };
  for (const step of HERO_ADJUSTMENTS) {
    if (step === 'SALE') {
      summary.saleId = await ensureHeroSale(ctx, token, productId);
      continue;
    }
    const [bucket, delta, reason, note] = step;
    if (
      await adjustOnce(
        ctx,
        token,
        productId,
        await idOf(bucket),
        delta,
        reason,
        note,
      )
    ) {
      summary.adjustments += 1;
    }
  }
  return summary;
}

// ── Sibling with variants: adjustments + REMOVAL (variant deleted) ─────────

async function runVariantKardex(ctx, token, productId, spec) {
  const { api, prisma, centro } = ctx;
  const summary = { adjustments: 0, removal: false };
  for (const adj of spec.variantAdjustments ?? []) {
    const variant = await prisma.variant.findFirst({
      where: { tenantId: centro.id, productId, name: adj.variant },
      select: { id: true },
    });
    if (!variant) continue;
    if (
      await adjustOnce(
        ctx,
        token,
        productId,
        { variantId: variant.id },
        adj.delta,
        adj.reason,
        adj.note,
      )
    ) {
      summary.adjustments += 1;
    }
  }
  if (spec.removeVariant) {
    const removed = await prisma.stockMovement.count({
      where: { tenantId: centro.id, productId, type: 'REMOVAL' },
    });
    const variant = await prisma.variant.findFirst({
      where: { tenantId: centro.id, productId, name: spec.removeVariant },
      select: { id: true },
    });
    if (removed === 0 && variant) {
      expectStatus(
        await api.http(
          'DELETE',
          `/products/${productId}/variants/${variant.id}`,
          { token },
        ),
        [200, 204],
        'delete variant',
      );
      summary.removal = true;
    }
  }
  return summary;
}

// ── Public catalog verification ────────────────────────────────────────────

async function publicStates(ctx) {
  const { api, centro } = ctx;
  const res = await api.http(
    'GET',
    `/public/catalog/${centro.slug}/products?limit=100`,
  );
  if (res.status !== 200) return { error: `HTTP ${res.status}` };
  const items = res.body.items ?? res.body.data ?? [];
  const states = {};
  for (const item of items) {
    const label = item.availability ?? 'sin dato';
    states[label] = (states[label] ?? 0) + 1;
  }
  return { listed: items.length, states };
}

async function run(ctx) {
  const { api, prisma, centro } = ctx;
  const manager = await api.login(MANAGER, centro.id);
  const admin = await api.login(ADMIN, centro.id);

  const refs = {
    categories: await ensureNamed(api, manager, '/categories', CATEGORIES),
    brands: await ensureNamed(api, manager, '/brands', [
      ...new Set(PRODUCTS.map((p) => p.brand).filter(Boolean)),
    ]),
    priceLists: await ensureNamed(api, admin, '/price-lists', [
      'Mayoreo',
      ...EXTRA_PRICE_LISTS,
    ]),
  };

  if (!centro.catalogPublished) {
    await prisma.tenant.update({
      where: { id: centro.id },
      data: { catalogPublished: true },
    });
  }

  const summary = { products: { created: 0, existing: 0 }, kardex: {} };
  for (const spec of PRODUCTS) {
    const { id, created } = await ensureProduct(ctx, manager, refs, spec);
    summary.products[created ? 'created' : 'existing'] += 1;
    if (spec.hero)
      summary.kardex.hero = {
        name: spec.name,
        ...(await runHero(ctx, manager, id)),
      };
    if (spec.variantAdjustments || spec.removeVariant) {
      summary.kardex.variants = {
        name: spec.name,
        ...(await runVariantKardex(ctx, manager, id, spec)),
      };
    }
  }

  const heroRow = await prisma.product.findFirstOrThrow({
    where: { tenantId: centro.id, name: HERO_NAME },
    select: { id: true },
  });
  const byType = await prisma.stockMovement.groupBy({
    by: ['type'],
    where: { tenantId: centro.id, productId: heroRow.id },
    _count: true,
  });
  summary.kardex.heroMovements = Object.fromEntries(
    byType.map((row) => [row.type, row._count]),
  );
  summary.totalProducts = await prisma.product.count({
    where: { tenantId: centro.id },
  });
  summary.publicCatalog = await publicStates(ctx);
  return summary;
}

module.exports = { name: 'catalog', run };
