'use strict';
// Editorial publish V2 runtime proof (S2–S5 for S7) over REAL HTTP against a running app and
// the dev DB. Works on two Centro showcase products and LEAVES THEM PUBLISHED on purpose:
// a food product (the main proof) and a care product (care confirmation order). Re-runnable:
// each run initializes a new draft from the current state and publishes the next revision.
// Writes the full evidence to EDITORIAL_EVIDENCE (default /tmp/editorial-publish-evidence.json)
// and never prints passwords or tokens.
//   INVENTORY_BASE_URL=http://127.0.0.1:3931 EDITORIAL_ADMIN_PASSWORD=… \
//   node scripts/editorial-publish-runtime/probe.cjs
const crypto = require('node:crypto');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {
  prismaClient,
  requireEnv,
  http,
  login,
  tenantBySlug,
} = require('../inventory-runtime/lib.cjs');

const ADMIN_EMAIL = process.env.EDITORIAL_ADMIN_EMAIL || 'admin@houndfe.com';
const FOOD_NAME = 'Croqueta Royal Canin Indoor para gato 1.5 kg';
const CARE_NAME = 'Shampoo de avena Bio-Groom para perro 355 ml';
const EVIDENCE =
  process.env.EDITORIAL_EVIDENCE || '/tmp/editorial-publish-evidence.json';
// Well-formed but not the installed vocabulary.
const STALE_REVISION = `ev2-sha256-${'0'.repeat(64)}`;
const key = () => crypto.randomUUID();
const records = [];

// Same recorder as scripts/inventory-runtime/probe.cjs.
function rec(specs, label, res, expectStatus, { error, check, fields } = {}) {
  let ok = res.status === expectStatus;
  let detail = '';
  if (ok && error !== undefined) {
    ok = res.body && res.body.error === error;
    if (!ok) detail = `expected error ${error}`;
  }
  if (ok && check) {
    try {
      check(res.body, res);
    } catch (e) {
      ok = false;
      detail = e.message.split('\n')[0];
    }
  }
  records.push({
    specs,
    label,
    status: res.status,
    expectStatus,
    ok,
    detail,
    body: fields ? fields(res.body) : res.body,
  });
  if (!ok)
    console.error(
      `FAIL ${specs} ${label}: HTTP ${res.status} ${detail} ${JSON.stringify(res.body).slice(0, 400)}`,
    );
  return res;
}

// Evidence dated yesterday (UTC) so it is never in the future on the server.
const verifiedOn = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const evidence = { sourceRef: 'Etiqueta del empaque', verifiedOn };
const known = (code, payload, withEvidence = true) => ({
  code,
  owner: 'sellable',
  variantId: null,
  state: 'known',
  payload,
  evidence: withEvidence ? evidence : null,
});
const fact = (key, value) => ({
  key,
  state: 'known',
  value,
  evidence,
  basis: 'Dice el empaque',
});
const doc = (
  familyCode,
  commercialTitle,
  values,
  declarations,
  careReview,
) => ({
  schemaVersion: 2,
  commercialTitle,
  description: null,
  mediaRefs: [],
  familyCode,
  values,
  facts: [
    {
      variantId: null,
      presentation: 'Pieza',
      declarations,
      careReview: careReview ?? null,
    },
  ],
});

// Food: incomplete = no net weight and food.format without evidence.
const foodDoc = (complete) =>
  doc(
    'food',
    FOOD_NAME,
    [
      known('animal.target', { type: 'multi', value: ['ani.dom.cat'] }),
      known(
        'food.format',
        { type: 'single', value: 'food.format.kibble' },
        complete,
      ),
      ...(complete
        ? [
            known('measure.net_mass', {
              type: 'number',
              value: 1.5,
              unit: 'kg',
            }),
          ]
        : []),
    ],
    [fact('contentMagnitude', 'mass')],
  );
const FOOD_MISSING = [
  {
    scope: 'definition',
    definitionCode: 'food.format',
    variantId: null,
    sectionCode: 'que-es',
    problem: 'EVIDENCE_REQUIRED',
    message: 'Agrega de dónde sale este dato.',
  },
  {
    scope: 'definition',
    definitionCode: 'measure.net_mass',
    variantId: null,
    sectionCode: 'contenido-empaque',
    problem: 'REQUIRED_MISSING',
    message: 'Falta el peso neto.',
  },
];

const careReview = () => ({
  state: 'prepared',
  jurisdiction: 'MX',
  intendedUse: 'Baño de perros',
  determination: 'identified',
  basis: 'Revisión de la etiqueta',
  evidence: [evidence],
  requirements: [
    {
      key: 'r',
      description: 'Uso externo en perros',
      disposition: 'satisfied',
      evidence: [evidence],
      basis: 'Indicado en el empaque',
    },
  ],
  warnings: [
    {
      key: 'w',
      requirementKeys: ['r'],
      text: 'Evitar el contacto con los ojos',
      disclosure: 'private_only',
      evidence: [evidence],
      handlingBasis: 'Se explica en mostrador',
    },
  ],
});
// Care: incomplete = no care review.
const careDoc = (complete) =>
  doc(
    'care',
    CARE_NAME,
    [
      known('care.type', { type: 'single', value: 'care.type.grooming' }),
      known('care.form', { type: 'single', value: 'care.form.solution' }),
      known('measure.net_volume', { type: 'number', value: 355, unit: 'ml' }),
    ],
    [
      fact('contentMagnitude', 'volume'),
      fact('presentationKind', 'formulation'),
    ],
    complete ? careReview() : null,
  );

async function main() {
  const prisma = prismaClient();
  const tenant = await tenantBySlug(prisma);
  const token = await login(
    ADMIN_EMAIL,
    requireEnv('EDITORIAL_ADMIN_PASSWORD'),
    tenant.id,
  );
  const vocabulary = await http('GET', '/catalog-editorial/vocabulary', {
    token,
  });
  assert.equal(vocabulary.status, 200, 'GET vocabulary');
  const R = vocabulary.body.vocabularyRevision;
  const pinned = (revision = R) => ({
    'editorial-vocabulary-revision': revision,
  });
  const base = (id) => `/products/${id}/editorial`;
  const read = (id) => http('GET', base(id), { token, headers: pinned() });
  const readiness = (id, revision) =>
    http('GET', `${base(id)}/draft/readiness`, {
      token,
      headers: pinned(revision),
    });
  const save = (id, expectedCycle, expectedRevision, document) =>
    http('PUT', `${base(id)}/draft`, {
      token,
      body: { expectedCycle, expectedRevision, document },
      headers: { ...pinned(), 'idempotency-key': key() },
    });
  const publish = (id, body, { k = key(), revision = R, care = null } = {}) =>
    http('POST', `${base(id)}/draft/publish`, {
      token,
      body,
      headers: {
        ...pinned(revision),
        'idempotency-key': k,
        ...(care ? { 'editorial-care-confirmation': care } : {}),
      },
    });
  const receiptCount = async (productId) =>
    (
      await prisma.$queryRaw`SELECT count(*)::int AS n FROM "catalog_editorial_publish_receipts"
        WHERE "tenantId" = ${tenant.id} AND "productId" = ${productId}`
    )[0].n;
  const product = async (name) => {
    const found = await prisma.product.findMany({
      where: { tenantId: tenant.id, name },
      select: { id: true, name: true },
    });
    assert.equal(found.length, 1, `exactly one Centro product «${name}»`);
    return found[0];
  };

  // A draft to work on: the saved one, or a new one initialized from the current state.
  async function draftOf(id) {
    const current = await read(id);
    assert.equal(current.status, 200, `read ${id}`);
    const { state } = current.body;
    if (state.draft)
      return { cycle: state.cycle, revision: state.draft.revision, state };
    const init = await http('POST', `${base(id)}/draft/initialize`, {
      token,
      body: { expectedCycle: state.cycle },
      headers: { ...pinned(), 'idempotency-key': key() },
    });
    rec(
      'S3',
      `initialize a draft (expectedCycle ${state.cycle})`,
      init,
      [200, 201].includes(init.status) ? init.status : 201,
      {
        fields: (b) => ({
          cycle: b.state?.cycle,
          draft: b.state?.draft?.revision,
          published: b.state?.published?.revision ?? null,
        }),
      },
    );
    return {
      cycle: init.body.state.cycle,
      revision: init.body.state.draft.revision,
      state: init.body.state,
    };
  }
  const summary = (b) => ({
    ready: b.ready,
    cycle: b.cycle,
    draftRevision: b.draftRevision,
    items: b.items,
    bySection: b.bySection,
  });

  // ── Food showcase: missing items → fix → publish ────────────────────────
  const food = await product(FOOD_NAME);
  let { cycle, revision, state } = await draftOf(food.id);
  const publishedBefore = state.published?.revision ?? null;

  let res = rec(
    'S2',
    'save incomplete food draft',
    await save(food.id, cycle, revision, foodDoc(false)),
    200,
  );
  revision = res.body.state.draft.revision;
  const notReady = rec(
    'S2 S5',
    'readiness of the incomplete draft: exact items and bySection',
    await readiness(food.id),
    200,
    {
      check: (b, r) => {
        assert.equal(b.ready, false);
        assert.equal(b.cycle, cycle);
        assert.equal(b.draftRevision, revision);
        assert.equal(b.vocabularyRevision, R);
        assert.deepEqual(b.items, FOOD_MISSING);
        assert.deepEqual(b.bySection, { 'que-es': 1, 'contenido-empaque': 1 });
        assert.equal(r.headers.get('cache-control'), 'no-store');
        assert.equal(r.headers.get('editorial-contract-version'), '2');
        assert.equal(r.headers.get('editorial-vocabulary-revision'), R);
      },
      fields: summary,
    },
  ).body;
  rec(
    'S2',
    'readiness with a stale vocabulary revision',
    await readiness(food.id, STALE_REVISION),
    409,
    { error: 'VOCABULARY_CHANGED' },
  );
  const receiptsBefore = await receiptCount(food.id);
  rec(
    'S4',
    'publish the incomplete draft: 400 with the readiness items',
    await publish(food.id, {
      expectedCycle: cycle,
      expectedRevision: revision,
    }),
    400,
    {
      error: 'MALFORMED',
      check: (b) => {
        assert.equal(b.statusCode, 400);
        assert.deepEqual(b.items, notReady.items);
        assert.deepEqual(b.bySection, notReady.bySection);
      },
    },
  );
  rec(
    'S4',
    'after the 400 nothing was written (draft and Published unchanged)',
    await read(food.id),
    200,
    {
      check: (b) => {
        assert.equal(b.state.cycle, cycle);
        assert.equal(b.state.draft.revision, revision);
        assert.equal(b.state.published?.revision ?? null, publishedBefore);
      },
      fields: (b) => ({
        cycle: b.state.cycle,
        draft: b.state.draft?.revision,
        published: b.state.published?.revision ?? null,
      }),
    },
  );
  records.push({
    specs: 'S4',
    label: 'after the 400 no publish receipt was recorded',
    status: null,
    expectStatus: null,
    ok: (await receiptCount(food.id)) === receiptsBefore,
    detail: '',
    body: { receiptsBefore, receiptsAfter: await receiptCount(food.id) },
  });

  res = rec(
    'S2',
    'save the missing values with evidence',
    await save(food.id, cycle, revision, foodDoc(true)),
    200,
  );
  revision = res.body.state.draft.revision;
  rec(
    'S2 S5',
    'readiness of the complete draft',
    await readiness(food.id),
    200,
    {
      check: (b) => {
        assert.deepEqual(summary(b), {
          ready: true,
          cycle,
          draftRevision: revision,
          items: [],
          bySection: {},
        });
      },
      fields: summary,
    },
  );

  const body = { expectedCycle: cycle, expectedRevision: revision };
  rec(
    'S3',
    'publish with a stale expectedRevision',
    await publish(food.id, {
      expectedCycle: cycle,
      expectedRevision: revision - 1,
    }),
    409,
    { error: 'CONFLICT' },
  );
  rec(
    'S3',
    'publish with a stale expectedCycle',
    await publish(food.id, {
      expectedCycle: cycle + 1,
      expectedRevision: revision,
    }),
    409,
    { error: 'CONFLICT' },
  );
  rec(
    'S3',
    'publish with a stale Editorial-Vocabulary-Revision',
    await publish(food.id, body, { revision: STALE_REVISION }),
    409,
    { error: 'VOCABULARY_CHANGED' },
  );
  rec(
    'S4',
    'publish a ready food draft with Editorial-Care-Confirmation: plain 400',
    await publish(food.id, body, { care: 'review-v1' }),
    400,
    {
      error: 'MALFORMED',
      check: (b) => assert.equal(b.items, undefined),
    },
  );

  const k = key();
  const first = rec(
    'S3',
    'publish the ready draft',
    await publish(food.id, body, { k }),
    200,
    {
      check: (b, r) => {
        assert.equal(b.contractVersion, 2);
        assert.equal(b.vocabularyRevision, R);
        assert.equal(b.state.cycle, cycle);
        assert.equal(b.state.draft, null);
        assert.equal(b.state.published.revision, (publishedBefore ?? 0) + 1);
        assert.deepEqual(b.state.published.document, foodDoc(true));
        assert.equal(r.headers.get('cache-control'), 'no-store');
        assert.equal(r.headers.get('editorial-contract-version'), '2');
        assert.equal(r.headers.get('editorial-vocabulary-revision'), R);
      },
      fields: (b) => ({
        contractVersion: b.contractVersion,
        cycle: b.state?.cycle,
        draft: b.state?.draft,
        publishedRevision: b.state?.published?.revision,
        commercialTitle: b.state?.published?.document?.commercialTitle,
      }),
    },
  );
  const firstText = JSON.stringify(first.body);
  rec(
    'S3',
    'replay: same Idempotency-Key and body → identical 200',
    await publish(food.id, body, { k }),
    200,
    {
      check: (b) => assert.equal(JSON.stringify(b), firstText),
      fields: (b) => ({ identical: JSON.stringify(b) === firstText }),
    },
  );
  rec(
    'S3',
    'same Idempotency-Key with a different body',
    await publish(
      food.id,
      { expectedCycle: cycle, expectedRevision: revision + 1 },
      { k },
    ),
    409,
    { error: 'CONFLICT' },
  );
  rec(
    'S3',
    'same Idempotency-Key and body with another vocabulary revision',
    await publish(food.id, body, { k, revision: STALE_REVISION }),
    409,
    { error: 'CONFLICT' },
  );
  rec(
    'S3',
    'new key, same body after publishing (no draft)',
    await publish(food.id, body),
    409,
    { error: 'CONFLICT' },
  );
  rec('S3', 'editorial read after publish', await read(food.id), 200, {
    check: (b) => {
      assert.equal(b.state.draft, null);
      assert.equal(b.state.published.revision, (publishedBefore ?? 0) + 1);
    },
    fields: (b) => ({
      cycle: b.state.cycle,
      draft: b.state.draft,
      published: b.state.published?.revision,
    }),
  });
  rec(
    'S2',
    'readiness after publish (no saved draft)',
    await readiness(food.id),
    200,
    {
      check: (b) => {
        assert.equal(b.ready, false);
        assert.equal(b.draftRevision, null);
        assert.deepEqual(
          b.items.map((i) => [i.scope, i.problem]),
          [['product', 'NO_DRAFT']],
        );
      },
      fields: summary,
    },
  );

  // ── Care showcase: readiness 400 first, then the confirmation 400 ───────
  const care = await product(CARE_NAME);
  ({ cycle, revision, state } = await draftOf(care.id));
  const carePublishedBefore = state.published?.revision ?? null;
  res = rec(
    'S4',
    'save incomplete care draft (no care review)',
    await save(care.id, cycle, revision, careDoc(false)),
    200,
  );
  revision = res.body.state.draft.revision;
  const careNotReady = rec(
    'S2 S5',
    'readiness of the care draft without review',
    await readiness(care.id),
    200,
    {
      check: (b) => {
        assert.equal(b.ready, false);
        assert(
          b.items.some(
            (i) => i.scope === 'care' && i.problem === 'CARE_REVIEW_INCOMPLETE',
          ),
        );
      },
      fields: summary,
    },
  ).body;
  for (const confirmation of [null, 'review-v1'])
    rec(
      'S4',
      `publish incomplete care draft ${confirmation ? 'with' : 'without'} confirmation: readiness 400 first`,
      await publish(
        care.id,
        { expectedCycle: cycle, expectedRevision: revision },
        { care: confirmation },
      ),
      400,
      {
        error: 'MALFORMED',
        check: (b) => {
          assert.deepEqual(b.items, careNotReady.items);
          assert.deepEqual(b.bySection, careNotReady.bySection);
        },
        fields: (b) => ({ error: b.error, items: b.items?.length }),
      },
    );
  res = rec(
    'S4',
    'save the care review',
    await save(care.id, cycle, revision, careDoc(true)),
    200,
  );
  revision = res.body.state.draft.revision;
  rec(
    'S2 S5',
    'readiness of the reviewed care draft',
    await readiness(care.id),
    200,
    {
      check: (b) => assert.equal(b.ready, true),
      fields: summary,
    },
  );
  const careBody = { expectedCycle: cycle, expectedRevision: revision };
  rec(
    'S4',
    'publish ready care draft without confirmation: plain 400',
    await publish(care.id, careBody),
    400,
    {
      error: 'MALFORMED',
      check: (b) => assert.equal(b.items, undefined),
    },
  );
  const careKey = key();
  rec(
    'S4',
    'publish ready care draft with review-v1',
    await publish(care.id, careBody, { k: careKey, care: 'review-v1' }),
    200,
    {
      check: (b) => {
        assert.equal(b.state.draft, null);
        assert.equal(
          b.state.published.revision,
          (carePublishedBefore ?? 0) + 1,
        );
      },
      fields: (b) => ({
        cycle: b.state?.cycle,
        draft: b.state?.draft,
        publishedRevision: b.state?.published?.revision,
      }),
    },
  );
  const [receipt] =
    await prisma.$queryRaw`SELECT "result" FROM "catalog_editorial_publish_receipts"
    WHERE "tenantId" = ${tenant.id} AND "productId" = ${care.id} AND "idempotencyKey" = ${careKey}`;
  const attestation = receipt?.result?.careAttestation ?? null;
  records.push({
    specs: 'S4',
    label: 'care publish receipt stores a fresh care attestation',
    status: null,
    expectStatus: null,
    ok: attestation !== null && typeof attestation === 'object',
    detail: '',
    body: attestation && {
      keys: Object.keys(attestation).sort(),
      publishedRevision: attestation.attempt?.publishedRevision,
    },
  });

  fs.writeFileSync(
    EVIDENCE,
    JSON.stringify(
      {
        tenant: tenant.slug,
        vocabularyRevision: R,
        showcase: { food, care },
        records,
      },
      null,
      2,
    ),
  );
  const failed = records.filter((r) => !r.ok);
  for (const r of records)
    console.log(
      `${r.ok ? 'PASS' : 'FAIL'} ${r.specs.padEnd(5)} HTTP ${String(r.status).padEnd(4)} ${r.label}`,
    );
  console.log(
    `\n${records.length - failed.length}/${records.length} probes passed; showcase: ${food.name} (${food.id}), ${care.name} (${care.id}); evidence: ${EVIDENCE}`,
  );
  await prisma.$disconnect();
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
