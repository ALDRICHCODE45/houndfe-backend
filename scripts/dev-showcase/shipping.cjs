// Dev showcase › shipping settings (Sucursal Centro): delivery zones of every
// type (one deactivated, one settled by a resolved validation), PENDING zone
// validations with requesters at OK / WARNING / CRITICAL urgency, two standard
// boxes, the shipping origin, the opening hours and packaging on five products
// plus one variant override.
//
// Everything goes through the real store API as manager@houndfe.com except
// the bot requesters: there is no staff endpoint to open a validation, so they
// are inserted exactly as PrismaDeliveryZoneBotRepository.submit does (same
// advisory lock, columns and canonical hash), without the notification outbox
// row (a seed never sends mail).
//
// Idempotent: only what is missing is created; existing rows are left as the FE
// edited them. Urgency is relative to the requesters' last message, so a later
// run re-anchors a PENDING showcase validation whose level drifted from the
// planned one (a same-day re-run changes nothing).
'use strict';

const crypto = require('node:crypto');
const { grant } = require('./org.cjs');

const MANAGER = 'manager@houndfe.com';
const HOUR_MS = 3_600_000;
// Same constants as src/delivery-zones (intake source, 24 h WhatsApp window).
const DELIVERY_ZONE_SOURCE = 'houndfe-chatbot';
const CUSTOMER_REPLY_WINDOW_MS = 24 * HOUR_MS;
const WARNING_THRESHOLD_MS = 12 * HOUR_MS;
const CRITICAL_THRESHOLD_MS = 4 * HOUR_MS;
// Audit-only column (no FK); marks the rows as written by the showcase.
const SHOWCASE_CREDENTIAL_ID = 'dev-showcase';
const CDMX = 'Ciudad de México';

// What prisma/seed.ts grants the Manager role; dev DBs seeded before the
// shipping work lack them. Additive only.
const MANAGER_SHIPPING_GRANTS = [
  ['DeliveryZone', 'read'],
  ['DeliveryZone', 'validate'],
  ['DeliveryZone', 'manage'],
  ['ShippingSettings', 'read'],
  ['ShippingSettings', 'update'],
];

// ── Data ───────────────────────────────────────────────────────────────────

const ZONES = [
  {
    zipCode: '03100',
    type: 'FREE',
    etaDays: 0,
    municipality: 'Benito Juárez',
    neighborhood: 'Del Valle Centro',
  },
  {
    zipCode: '03020',
    type: 'FREE',
    etaDays: 1,
    municipality: 'Benito Juárez',
    neighborhood: 'Narvarte Poniente',
  },
  {
    zipCode: '03810',
    type: 'FREE',
    etaDays: 1,
    municipality: 'Benito Juárez',
    neighborhood: 'Nápoles',
  },
  {
    zipCode: '06700',
    type: 'SURCHARGE',
    surchargeCents: 4500,
    etaDays: 2,
    municipality: 'Cuauhtémoc',
    neighborhood: 'Roma Norte',
  },
  {
    zipCode: '04000',
    type: 'SURCHARGE',
    surchargeCents: 6900,
    etaDays: 2,
    municipality: 'Coyoacán',
    neighborhood: 'Villa Coyoacán',
  },
  {
    zipCode: '16000',
    type: 'CARRIER_ONLY',
    municipality: 'Xochimilco',
    neighborhood: 'Xochimilco Centro',
  },
  {
    zipCode: '14000',
    type: 'CARRIER_ONLY',
    municipality: 'Tlalpan',
    neighborhood: 'Tlalpan Centro',
  },
  {
    zipCode: '12000',
    type: 'DENIED',
    municipality: 'Milpa Alta',
    neighborhood: 'Villa Milpa Alta',
  },
  // Deactivated: the bot treats it as an unknown postal code.
  {
    zipCode: '03300',
    type: 'FREE',
    etaDays: 1,
    municipality: 'Benito Juárez',
    neighborhood: 'Portales Norte',
    isActive: false,
  },
];

// Bot requesters; `hoursAgo` is the customer's last WhatsApp message. The
// oldest PENDING requester drives the urgency (24 h − hoursAgo left).
const VALIDATIONS = [
  {
    key: 'cp-06600',
    zipCode: '06600',
    municipality: 'Cuauhtémoc',
    neighborhood: 'Juárez',
    level: 'WARNING',
    requesters: [
      { key: 'cp-06600-1', hoursAgo: 15, phone: '5512340601' },
      { key: 'cp-06600-2', hoursAgo: 3, phone: '5512340602' },
    ],
  },
  {
    key: 'cp-03900',
    zipCode: '03900',
    municipality: 'Benito Juárez',
    neighborhood: 'San José Insurgentes',
    level: 'CRITICAL',
    requesters: [{ key: 'cp-03900-1', hoursAgo: 21, phone: '5512340391' }],
  },
  {
    key: 'cp-04510',
    zipCode: '04510',
    municipality: 'Coyoacán',
    neighborhood: 'Ciudad Universitaria',
    level: 'OK',
    requesters: [{ key: 'cp-04510-1', hoursAgo: 2, phone: '5512340451' }],
  },
  // Approved through POST /delivery-zone-validations/:id/resolve, so its zone
  // carries `sourceValidationId` and the detail screen has a RESOLVED case.
  {
    key: 'cp-11000',
    zipCode: '11000',
    municipality: 'Miguel Hidalgo',
    neighborhood: 'Lomas de Chapultepec',
    requesters: [{ key: 'cp-11000-1', hoursAgo: 20, phone: '5512341100' }],
    resolve: {
      action: 'APPROVE_DELIVERY_ZONE',
      zoneType: 'SURCHARGE',
      surchargeCents: 8900,
      etaDays: 3,
    },
  },
];

const BOXES = [
  {
    name: 'Caja chica',
    innerLengthCm: 30,
    innerWidthCm: 20,
    innerHeightCm: 15,
    weightG: 180,
    maxContentWeightG: 5000,
  },
  {
    name: 'Caja mediana',
    innerLengthCm: 45,
    innerWidthCm: 35,
    innerHeightCm: 30,
    weightG: 420,
    maxContentWeightG: 20000,
  },
];

// Same street as the sucursal profile in org.cjs.
const ORIGIN = {
  addressLine1: 'Av. Insurgentes Sur 1458',
  addressLine2: 'Local 3, planta baja',
  neighborhood: 'Del Valle Centro',
  municipality: 'Benito Juárez',
  state: CDMX,
  postalCode: '03100',
  contactPhone: '5555432100',
};

const SPLIT_SHIFT = [
  { open: '09:00', close: '14:00' },
  { open: '16:00', close: '19:30' },
];
const OPENING_HOURS = {
  timeZone: 'America/Mexico_City',
  days: [
    { day: 'MONDAY', ranges: SPLIT_SHIFT },
    { day: 'TUESDAY', ranges: SPLIT_SHIFT },
    { day: 'WEDNESDAY', ranges: SPLIT_SHIFT },
    { day: 'THURSDAY', ranges: SPLIT_SHIFT },
    { day: 'FRIDAY', ranges: SPLIT_SHIFT },
    { day: 'SATURDAY', ranges: [{ open: '09:00', close: '14:00' }] },
    { day: 'SUNDAY', ranges: [] },
  ],
};

// Products from catalog.cjs; packed weight (g) and outer size (cm).
const PACKAGING = [
  {
    product: 'Alimento para Cachorro Raza Mediana 3 kg',
    weightG: 3150,
    lengthCm: 35,
    widthCm: 22,
    heightCm: 10,
  },
  {
    product: 'Arena Sanitaria Aglomerante 10 kg',
    weightG: 10300,
    lengthCm: 40,
    widthCm: 28,
    heightCm: 12,
  },
  {
    product: 'Shampoo Hipoalergénico 500 ml',
    weightG: 560,
    lengthCm: 20.5,
    widthCm: 7,
    heightCm: 5.5,
  },
  {
    product: 'Desparasitante Oral Canino 10 ml',
    weightG: 45,
    lengthCm: 9.5,
    widthCm: 4,
    heightCm: 2.5,
  },
  {
    product: 'Arnés Acolchado para Paseo',
    weightG: 320,
    lengthCm: 25,
    widthCm: 18,
    heightCm: 4.5,
  },
];
// Whole-record override: the other Arnés variants inherit the product record.
const VARIANT_PACKAGING = [
  {
    product: 'Arnés Acolchado para Paseo',
    variant: 'Grande',
    weightG: 480,
    lengthCm: 32,
    widthCm: 22,
    heightCm: 5.5,
  },
];

// ── Pure helpers ───────────────────────────────────────────────────────────

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

/** Same level rule as computeValidationUrgency in delivery-zone.policy.ts. */
function urgencyLevel(lastCustomerMessageAt, now) {
  const leftMs = Math.max(
    0,
    lastCustomerMessageAt.getTime() + CUSTOMER_REPLY_WINDOW_MS - now.getTime(),
  );
  if (leftMs === 0) return 'EXPIRED';
  if (leftMs < CRITICAL_THRESHOLD_MS) return 'CRITICAL';
  if (leftMs < WARNING_THRESHOLD_MS) return 'WARNING';
  return 'OK';
}

/** The intake body the bot would send for one showcase requester. */
function intakeRequest(validation, requester, now) {
  return {
    sourceRequestId: stableUuid(`delivery-zone-request:${requester.key}`),
    type: 'DELIVERY_ZONE',
    zipCode: validation.zipCode,
    state: CDMX,
    municipality: validation.municipality,
    neighborhood: validation.neighborhood,
    phoneCountryCode: '52',
    phone: requester.phone,
    conversationRef: `wa:showcase-${requester.key}`,
    lastCustomerMessageAt: new Date(
      now.getTime() - requester.hoursAgo * HOUR_MS,
    ),
  };
}

/** Byte-for-byte hashDeliveryZoneIntake (delivery-zone-intake.request.ts). */
function hashIntake(request) {
  const canonical = {
    conversationRef: request.conversationRef,
    lastCustomerMessageAt: request.lastCustomerMessageAt.toISOString(),
    municipality: request.municipality,
    neighborhood: request.neighborhood,
    phone: request.phone,
    phoneCountryCode: request.phoneCountryCode,
    sourceRequestId: request.sourceRequestId,
    state: request.state,
    type: request.type,
    zipCode: request.zipCode,
  };
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}

/** PUT /delivery-zones/:zipCode body for a zone spec. */
function zoneBody(spec) {
  return {
    type: spec.type,
    ...(spec.surchargeCents === undefined
      ? {}
      : { surchargeCents: spec.surchargeCents }),
    ...(spec.etaDays === undefined ? {} : { etaDays: spec.etaDays }),
    state: CDMX,
    municipality: spec.municipality,
    neighborhood: spec.neighborhood,
  };
}

/** Steps for one zone: nothing when it already exists (FE edits are kept). */
function planZone(spec, existing) {
  if (existing) return [];
  return spec.isActive === false ? ['put', 'deactivate'] : ['put'];
}

/** Box specs whose name is not taken yet in the sucursal. */
function planBoxes(specs, existing) {
  const names = new Set(existing.map((box) => box.name));
  return specs.filter((spec) => !names.has(spec.name));
}

/**
 * Requesters to re-anchor: those of a PENDING showcase validation whose current
 * level (oldest PENDING requester) is not the planned one.
 */
function planReanchor(spec, validation, requesters, now) {
  if (!spec.level || !validation || validation.status !== 'PENDING') return [];
  const pending = requesters.filter((row) => row.status === 'PENDING');
  if (pending.length === 0) return [];
  const oldest = new Date(
    Math.min(...pending.map((row) => row.lastCustomerMessageAt.getTime())),
  );
  return urgencyLevel(oldest, now) === spec.level ? [] : pending;
}

// ── Steps ──────────────────────────────────────────────────────────────────

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

async function ensureGrants(ctx) {
  const { prisma } = ctx;
  let created = 0;
  for (const tenant of [ctx.centro, ctx.norte]) {
    const role = await prisma.role.findUnique({
      where: { tenantId_name: { tenantId: tenant.id, name: 'Manager' } },
    });
    if (role) created += await grant(prisma, role, MANAGER_SHIPPING_GRANTS);
  }
  return created;
}

async function ensureZones(ctx, token) {
  const { api } = ctx;
  const counts = { created: 0, existing: 0 };
  for (const spec of ZONES) {
    const route = `/delivery-zones/${spec.zipCode}`;
    const current = await api.http('GET', route, { token });
    expectStatus(current, [200, 404], `GET ${route}`);
    const steps = planZone(spec, current.status === 200 ? current.body : null);
    if (steps.length === 0) counts.existing += 1;
    for (const step of steps) {
      if (step === 'put') {
        expectStatus(
          await api.http('PUT', route, { token, body: zoneBody(spec) }),
          200,
          `PUT ${route}`,
        );
        counts.created += 1;
      } else {
        expectStatus(
          await api.http('DELETE', route, { token }),
          200,
          `DELETE ${route}`,
        );
      }
    }
  }
  return counts;
}

/**
 * One bot requester, as PrismaDeliveryZoneBotRepository.submit: under the
 * per-postal-code lock, an existing sourceRequestId is kept; an active zone
 * resolves the requester at once (EXISTING_ZONE); otherwise it joins (or
 * opens) the single PENDING validation of the postal code.
 */
async function submitRequester(ctx, request) {
  const { prisma, centro } = ctx;
  return prisma.$transaction(async (tx) => {
    const lockKey = JSON.stringify([
      'delivery_zone',
      centro.id,
      request.zipCode,
    ]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
    const existing = await tx.deliveryZoneRequest.findFirst({
      where: {
        tenantId: centro.id,
        source: DELIVERY_ZONE_SOURCE,
        sourceRequestId: request.sourceRequestId,
      },
      select: { id: true },
    });
    if (existing) return 'existing';

    const base = {
      tenantId: centro.id,
      source: DELIVERY_ZONE_SOURCE,
      sourceRequestId: request.sourceRequestId,
      canonicalRequestHash: hashIntake(request),
      submittedCredentialId: SHOWCASE_CREDENTIAL_ID,
      branchName: centro.name,
      zipCode: request.zipCode,
      state: request.state,
      municipality: request.municipality,
      neighborhood: request.neighborhood,
      customerPhoneCountryCode: request.phoneCountryCode,
      customerPhone: request.phone,
      conversationRef: request.conversationRef,
      lastCustomerMessageAt: request.lastCustomerMessageAt,
    };
    const zone = await tx.deliveryZone.findFirst({
      where: { tenantId: centro.id, zipCode: request.zipCode, isActive: true },
      select: { type: true, surchargeCents: true, etaDays: true },
    });
    if (zone) {
      await tx.deliveryZoneRequest.create({
        data: {
          ...base,
          status: 'RESOLVED',
          version: 2,
          resolutionSource: 'EXISTING_ZONE',
          zoneType: zone.type,
          surchargeCents: zone.surchargeCents,
          etaDays: zone.etaDays,
          resolvedAt: new Date(),
        },
      });
      return 'existing-zone';
    }
    let validation = await tx.deliveryZoneValidation.findFirst({
      where: {
        tenantId: centro.id,
        zipCode: request.zipCode,
        status: 'PENDING',
      },
      select: { id: true },
    });
    validation ??= await tx.deliveryZoneValidation.create({
      data: {
        tenantId: centro.id,
        zipCode: request.zipCode,
        state: request.state,
        municipality: request.municipality,
        neighborhood: request.neighborhood,
        branchName: centro.name,
      },
      select: { id: true },
    });
    await tx.deliveryZoneRequest.create({
      data: { ...base, validationId: validation.id },
    });
    return 'created';
  });
}

/** Moves the requesters' last message back to the planned offsets (same hash rule). */
async function reanchor(ctx, spec, rows) {
  const { prisma, centro, today } = ctx;
  const byId = new Map(
    spec.requesters.map((requester) => [
      stableUuid(`delivery-zone-request:${requester.key}`),
      requester,
    ]),
  );
  await prisma.$transaction(async (tx) => {
    const lockKey = JSON.stringify(['delivery_zone', centro.id, spec.zipCode]);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))::text`;
    for (const row of rows) {
      const requester = byId.get(row.sourceRequestId);
      if (!requester) continue;
      const request = intakeRequest(spec, requester, today);
      await tx.deliveryZoneRequest.updateMany({
        where: { id: row.id, tenantId: centro.id, status: 'PENDING' },
        data: {
          lastCustomerMessageAt: request.lastCustomerMessageAt,
          canonicalRequestHash: hashIntake(request),
        },
      });
    }
  });
}

async function ensureValidations(ctx, token) {
  const { api, prisma, centro, today } = ctx;
  const summary = {
    requestersCreated: 0,
    reanchored: 0,
    resolved: 0,
    byZip: {},
  };
  for (const spec of VALIDATIONS) {
    const ids = spec.requesters.map((requester) =>
      stableUuid(`delivery-zone-request:${requester.key}`),
    );
    for (const requester of spec.requesters) {
      const outcome = await submitRequester(
        ctx,
        intakeRequest(spec, requester, today),
      );
      if (outcome !== 'existing') summary.requestersCreated += 1;
    }
    const rows = await prisma.deliveryZoneRequest.findMany({
      where: {
        tenantId: centro.id,
        source: DELIVERY_ZONE_SOURCE,
        sourceRequestId: { in: ids },
      },
      select: {
        id: true,
        sourceRequestId: true,
        status: true,
        validationId: true,
        lastCustomerMessageAt: true,
      },
    });
    const validationId = rows.find((row) => row.validationId)?.validationId;
    let validation = validationId
      ? await prisma.deliveryZoneValidation.findUnique({
          where: { id: validationId },
          select: { id: true, status: true, version: true },
        })
      : null;

    const drifted = planReanchor(spec, validation, rows, today);
    if (drifted.length > 0) {
      await reanchor(ctx, spec, drifted);
      summary.reanchored += drifted.length;
    }

    if (spec.resolve && validation?.status === 'PENDING') {
      expectStatus(
        await api.http(
          'POST',
          `/delivery-zone-validations/${validation.id}/resolve`,
          {
            token,
            body: {
              expectedVersion: validation.version,
              resolutionRequestId: stableUuid(
                `delivery-zone-resolve:${spec.key}`,
              ),
              ...spec.resolve,
            },
          },
        ),
        200,
        `resolve validation ${spec.zipCode}`,
      );
      summary.resolved += 1;
      validation = { ...validation, status: 'RESOLVED' };
    }
    summary.byZip[spec.zipCode] = validation?.status ?? 'NO_VALIDATION';
  }
  return summary;
}

async function ensureBoxes(ctx, token) {
  const { api, centro } = ctx;
  const route = `/tenants/${centro.id}/shipping-boxes`;
  const listed = expectStatus(
    await api.http('GET', route, { token }),
    200,
    `GET ${route}`,
  );
  const missing = planBoxes(BOXES, listed.data);
  for (const spec of missing) {
    expectStatus(
      await api.http('POST', route, { token, body: spec }),
      201,
      `create box ${spec.name}`,
    );
  }
  return { created: missing.length, existing: BOXES.length - missing.length };
}

/** GET → PUT only while the sucursal record is unconfigured. */
async function ensureSingleton(ctx, token, route, body) {
  const current = expectStatus(
    await ctx.api.http('GET', route, { token }),
    200,
    `GET ${route}`,
  );
  if (current.configured) return 'existing';
  expectStatus(
    await ctx.api.http('PUT', route, { token, body }),
    200,
    `PUT ${route}`,
  );
  return 'created';
}

async function ensurePackaging(ctx, token) {
  const { api, prisma, centro } = ctx;
  const counts = { created: 0, existing: 0 };
  const productId = async (name) => {
    const row = await prisma.product.findFirst({
      where: { tenantId: centro.id, name },
      select: { id: true },
    });
    if (!row) throw new StepError(`product missing (run catalog): ${name}`);
    return row.id;
  };
  const put = async (route, record, isSet) => {
    const current = expectStatus(
      await api.http('GET', route, { token }),
      200,
      `GET ${route}`,
    );
    if (isSet(current)) {
      counts.existing += 1;
      return;
    }
    const { weightG, lengthCm, widthCm, heightCm } = record;
    expectStatus(
      await api.http('PUT', route, {
        token,
        body: { weightG, lengthCm, widthCm, heightCm },
      }),
      200,
      `PUT ${route}`,
    );
    counts.created += 1;
  };

  for (const spec of PACKAGING) {
    const id = await productId(spec.product);
    await put(`/products/${id}/packaging`, spec, (body) => body.packaging);
  }
  for (const spec of VARIANT_PACKAGING) {
    const id = await productId(spec.product);
    const variant = await prisma.variant.findFirst({
      where: { productId: id, name: spec.variant },
      select: { id: true },
    });
    if (!variant) {
      throw new StepError(`variant missing: ${spec.product} › ${spec.variant}`);
    }
    await put(
      `/products/${id}/variants/${variant.id}/packaging`,
      spec,
      (body) => body.override,
    );
  }
  return counts;
}

async function run(ctx) {
  const { api, centro } = ctx;
  const grantsCreated = await ensureGrants(ctx);
  const token = await api.login(MANAGER, centro.id);
  return {
    grantsCreated,
    zones: await ensureZones(ctx, token),
    validations: await ensureValidations(ctx, token),
    boxes: await ensureBoxes(ctx, token),
    origin: await ensureSingleton(
      ctx,
      token,
      `/tenants/${centro.id}/shipping-origin`,
      ORIGIN,
    ),
    openingHours: await ensureSingleton(
      ctx,
      token,
      `/tenants/${centro.id}/opening-hours`,
      OPENING_HOURS,
    ),
    packaging: await ensurePackaging(ctx, token),
  };
}

module.exports = {
  name: 'shipping',
  run,
  ZONES,
  VALIDATIONS,
  BOXES,
  ORIGIN,
  OPENING_HOURS,
  PACKAGING,
  VARIANT_PACKAGING,
  MANAGER_SHIPPING_GRANTS,
  stableUuid,
  urgencyLevel,
  intakeRequest,
  hashIntake,
  zoneBody,
  planZone,
  planBoxes,
  planReanchor,
};
