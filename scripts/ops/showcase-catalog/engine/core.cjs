// Ops › showcase catalog › engine core: the pure parts of
// scripts/ops/load-showcase-catalog.cjs (no Nest, no Prisma, no network), so
// they can be tested offline with `node --test`.
//
// Data contract (odd/tasks/prod-showcase-catalog.md L5) — each product spec:
//   { key, name, sku, category, brand, description, price, mayoreo, cost,
//     iva?, stock?, variants?: [{ key, name, sku, price, mayoreo, stock }],
//     packaging: { weightG, lengthCm, widthCm, heightCm },
//     images: [{ url, credit, license, sourcePage }],
//     editorial: { familyCode, commercialTitle, description,
//                  values: [{ code, payload, variantKey }],
//                  facts: [{ variantKey, presentation,
//                            declarations: [{ key, state, value, basis }],
//                            careReview? }] } }
// Money is in pesos. A product with variants carries every value and fact
// once per variant (variantKey set); a simple product uses variantKey null.
'use strict';

const SKU_PREFIX = 'SC-';
// The public catalog reports low stock at quantity <= minQuantity, so 1-5
// units read as «pocas piezas» and 0 as out of stock.
const LOW_STOCK_THRESHOLD = 5;
const SKU_PATTERN = /^SC-[A-Z0-9][A-Z0-9_-]*$/;
const EVIDENCE_SOURCE = 'Ficha del fabricante';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const IVA_RATES = ['IVA_16', 'IVA_8', 'IVA_0', 'IVA_EXENTO'];
const DECLARATION_KEYS = [
  'contentMagnitude',
  'consumable',
  'animalApplied',
  'fitDeterminesChoice',
  'capacityDeterminesChoice',
  'electricalApplies',
  'relevantDimensionCodes',
  'relevantFitCodes',
  'relevantCapacityCodes',
  'relevantEquipmentCodes',
  'presentationKind',
  'optionalNonpertinenceCodes',
];

const peso = (amount) => Math.round(amount * 100);
const isShowcaseSku = (sku) =>
  typeof sku === 'string' && sku.toUpperCase().startsWith(SKU_PREFIX);

/** YYYY-MM-DD of `date` in UTC, the editorial `verifiedOn` format. */
const isoDay = (date = new Date()) => date.toISOString().slice(0, 10);

const evidenceOf = (today) => ({
  sourceRef: EVIDENCE_SOURCE,
  verifiedOn: today,
});

const isPositive = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const isStock = (value) => Number.isInteger(value) && value >= 0;
const text = (value, max, min = 1) =>
  typeof value === 'string' &&
  value.trim().length >= min &&
  [...value].length <= max;

/** Same rule the image downloader enforces before any request. */
function isAllowedImageUrl(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Base MIME type of a Content-Type header, lowercase, without parameters. */
const baseMime = (header) =>
  String(header ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();

/** Index of the editorial vocabulary: family bindings and definitions by code. */
function indexVocabulary(vocabulary) {
  const definitions = new Map(
    vocabulary.definitions.map((definition) => [definition.code, definition]),
  );
  const families = new Map(
    vocabulary.families.map((family) => [
      family.code,
      new Map(
        family.bindings.map((binding) => [binding.definitionCode, binding]),
      ),
    ]),
  );
  return { definitions, families };
}

/** Problems of a known payload against its definition; [] when valid. */
function payloadProblems(payload, definition) {
  if (!payload || typeof payload !== 'object') return ['payload missing'];
  if (payload.type !== definition.type) {
    return [
      `payload type ${payload.type} but definition is ${definition.type}`,
    ];
  }
  const options = new Map(
    (definition.options ?? []).map((option) => [option.code, option]),
  );
  const units = new Set((definition.units ?? []).map((unit) => unit.code));
  const option = (code) => {
    const found = options.get(code);
    if (!found) return `unknown option ${code}`;
    if (found.archived) return `archived option ${code}`;
    return null;
  };
  const unit = (code, nullable) => {
    if (code === null && nullable && units.size === 0) return null;
    return units.has(code) ? null : `unit ${code} not in [${[...units]}]`;
  };
  const problems = [];
  switch (payload.type) {
    case 'text':
      if (!text(payload.value, 20000)) problems.push('empty text');
      break;
    case 'boolean':
      if (typeof payload.value !== 'boolean') problems.push('not a boolean');
      break;
    case 'single':
      problems.push(option(payload.value));
      break;
    case 'multi':
      if (!Array.isArray(payload.value) || payload.value.length === 0) {
        problems.push('empty multi');
      } else {
        if (new Set(payload.value).size !== payload.value.length) {
          problems.push('duplicated options');
        }
        problems.push(...payload.value.map(option));
      }
      break;
    case 'number':
      if (!isPositive(payload.value)) problems.push('number must be > 0');
      problems.push(unit(payload.unit, true));
      break;
    case 'range':
      if (
        !Number.isFinite(payload.min) ||
        !Number.isFinite(payload.max) ||
        payload.min < 0 ||
        payload.min > payload.max
      ) {
        problems.push('range needs 0 <= min <= max');
      }
      problems.push(unit(payload.unit, false));
      break;
    default:
      problems.push(`unknown payload type ${payload.type}`);
  }
  return problems.filter(Boolean);
}

function editorialProblems(spec, vocab, push) {
  const editorial = spec.editorial;
  if (!editorial || typeof editorial !== 'object') {
    push('editorial missing');
    return;
  }
  const bindings = vocab.families.get(editorial.familyCode);
  if (!bindings) {
    push(`editorial.familyCode "${editorial.familyCode}" is not a family`);
    return;
  }
  if (!text(editorial.commercialTitle, 200)) {
    push('editorial.commercialTitle must be 1..200 characters');
  }
  if (!text(editorial.description, 20000)) {
    push('editorial.description must be 1..20000 characters');
  }
  const hasVariants = (spec.variants ?? []).length > 0;
  const variantKeys = new Set((spec.variants ?? []).map((v) => v.key));
  const subject = (variantKey, label) => {
    if (hasVariants) {
      if (variantKey === null || variantKey === undefined) {
        push(`${label}: a product with variants needs a variantKey`);
        return false;
      }
      if (!variantKeys.has(variantKey)) {
        push(`${label}: unknown variantKey "${variantKey}"`);
        return false;
      }
    } else if (variantKey !== null && variantKey !== undefined) {
      push(`${label}: a simple product takes variantKey null`);
      return false;
    }
    return true;
  };

  const values = Array.isArray(editorial.values) ? editorial.values : [];
  if (values.length === 0) push('editorial.values is empty');
  if (values.length > 200) push('editorial.values exceeds 200');
  const seenValues = new Set();
  values.forEach((value, index) => {
    const label = `values[${index}] ${value?.code}`;
    const binding = bindings.get(value?.code);
    if (!binding) {
      push(`${label}: not bound to family ${editorial.familyCode}`);
      return;
    }
    subject(value.variantKey ?? null, label);
    const id = `${value.code}@${value.variantKey ?? ''}`;
    if (seenValues.has(id)) push(`${label}: duplicated for this subject`);
    seenValues.add(id);
    const state = value.state ?? 'known';
    if (state === 'known') {
      for (const problem of payloadProblems(
        value.payload,
        vocab.definitions.get(value.code),
      )) {
        push(`${label}: ${problem}`);
      }
    } else if (state !== 'unknown' && state !== 'not_applicable') {
      push(`${label}: unknown state ${state}`);
    }
  });

  const facts = Array.isArray(editorial.facts) ? editorial.facts : [];
  if (facts.length > 200) push('editorial.facts exceeds 200');
  const seenFacts = new Set();
  facts.forEach((fact, index) => {
    const label = `facts[${index}]`;
    if (!subject(fact?.variantKey ?? null, label)) return;
    const id = fact.variantKey ?? '';
    if (seenFacts.has(id)) push(`${label}: duplicated for this subject`);
    seenFacts.add(id);
    if (!text(fact.presentation, 200)) push(`${label}: presentation missing`);
    for (const declaration of fact.declarations ?? []) {
      if (!DECLARATION_KEYS.includes(declaration?.key)) {
        push(`${label}: unknown declaration ${declaration?.key}`);
      } else if ((declaration.state ?? 'known') === 'known') {
        if (!text(declaration.basis, 1000)) {
          push(`${label}: declaration ${declaration.key} needs a basis`);
        }
      }
    }
    if (fact.careReview != null && editorial.familyCode !== 'care') {
      push(`${label}: careReview only belongs to the care family`);
    }
  });
  if (hasVariants) {
    for (const key of variantKeys) {
      if (facts.length && !seenFacts.has(key)) {
        push(`facts: variant "${key}" has no facts row`);
      }
    }
  }
}

/**
 * Every problem of the data set, as readable strings; [] when it can be
 * written. `vocabulary` is the tenant's current editorial vocabulary
 * (`{ families, definitions }`), `existingSkus` the upper-case SKUs already
 * taken in the tenant by products outside this data set.
 */
function validateCatalog(products, vocabulary, { existingSkus = [] } = {}) {
  const problems = [];
  const vocab = indexVocabulary(vocabulary);
  if (!Array.isArray(products) || products.length === 0) {
    return ['no products to load'];
  }
  const keys = new Set();
  const skus = new Map();
  const taken = new Set(existingSkus.map((sku) => sku.toUpperCase()));
  const claim = (sku, owner, push) => {
    if (typeof sku !== 'string' || !SKU_PATTERN.test(sku)) {
      push(
        `SKU "${sku}" must match ${SKU_PATTERN} (upper case, ${SKU_PREFIX} prefix)`,
      );
      return;
    }
    if (skus.has(sku)) push(`SKU ${sku} also used by ${skus.get(sku)}`);
    skus.set(sku, owner);
    if (taken.has(sku)) push(`SKU ${sku} already taken by another product`);
  };

  products.forEach((spec, index) => {
    const label = `#${index + 1} ${spec?.key ?? '(no key)'}`;
    const push = (message) => problems.push(`${label}: ${message}`);
    if (!text(spec?.key, 100)) push('key missing');
    else if (keys.has(spec.key)) push('duplicated key');
    keys.add(spec?.key);
    if (!text(spec?.name, 100)) push('name must be 1..100 characters');
    claim(spec?.sku, spec?.key, push);
    if (!text(spec?.category, 50)) push('category must be 1..50 characters');
    if (!text(spec?.brand, 50, 2)) push('brand must be 2..50 characters');
    if (!text(spec?.description, 2000)) {
      push('description must be 1..2000 characters');
    }
    if (!isPositive(spec?.price)) push('price must be > 0');
    if (!isPositive(spec?.mayoreo)) push('mayoreo must be > 0');
    if (!(typeof spec?.cost === 'number' && spec.cost >= 0)) {
      push('cost must be >= 0');
    }
    if (spec?.iva !== undefined && !IVA_RATES.includes(spec.iva)) {
      push(`iva must be one of ${IVA_RATES.join(', ')}`);
    }
    const variants = spec?.variants ?? [];
    if (!Array.isArray(variants)) push('variants must be an array');
    if (variants.length === 0) {
      if (!isStock(spec?.stock)) push('stock must be an integer >= 0');
    } else {
      if (spec.stock !== undefined) {
        push('stock belongs to each variant when there are variants');
      }
      const variantKeys = new Set();
      variants.forEach((variant, position) => {
        const where = `variants[${position}] ${variant?.key ?? ''}`.trim();
        if (!text(variant?.key, 100)) push(`${where}: key missing`);
        else if (variantKeys.has(variant.key)) push(`${where}: duplicated key`);
        variantKeys.add(variant?.key);
        if (!text(variant?.name, 100)) push(`${where}: name must be 1..100`);
        claim(variant?.sku, `${spec?.key}/${variant?.key}`, push);
        if (!isPositive(variant?.price)) push(`${where}: price must be > 0`);
        if (!isPositive(variant?.mayoreo))
          push(`${where}: mayoreo must be > 0`);
        if (!isStock(variant?.stock)) push(`${where}: stock must be >= 0`);
      });
    }
    const pack = spec?.packaging;
    if (
      !pack ||
      !['weightG', 'lengthCm', 'widthCm', 'heightCm'].every((field) =>
        isPositive(pack[field]),
      )
    ) {
      push('packaging needs weightG, lengthCm, widthCm, heightCm > 0');
    }
    const images = spec?.images ?? [];
    if (!Array.isArray(images) || images.length === 0) push('images missing');
    else {
      images.forEach((image, position) => {
        if (!isAllowedImageUrl(image?.url)) {
          push(`images[${position}]: url must be https`);
        }
      });
    }
    editorialProblems(spec ?? {}, vocab, push);
  });
  return problems;
}

/** Products and variants of the data set whose SKU must be unique. */
const catalogSkus = (products) =>
  products.flatMap((spec) => [
    spec.sku,
    ...(spec.variants ?? []).map((variant) => variant.sku),
  ]);

/**
 * CreateProductDto body. `lists` holds global price-list ids:
 * `{ defaultId, catalogDefaultId, mayoreoId }` (the global isDefault list,
 * the tenant's catalog default, Mayoreo); `refs` the category/brand ids.
 */
function productBody(spec, refs, lists) {
  const variants = spec.variants ?? [];
  const priceLists = [
    { priceListId: lists.mayoreoId, priceCents: peso(spec.mayoreo) },
  ];
  if (lists.catalogDefaultId && lists.catalogDefaultId !== lists.defaultId) {
    priceLists.push({
      priceListId: lists.catalogDefaultId,
      priceCents: peso(spec.price),
    });
  }
  const body = {
    name: spec.name,
    description: spec.description,
    type: 'PRODUCT',
    sku: spec.sku,
    priceCents: peso(spec.price),
    priceLists,
    ivaRate: spec.iva ?? 'IVA_16',
    purchaseCost: { mode: 'NET', valueCents: peso(spec.cost) },
    sellInPos: true,
    includeInOnlineCatalog: true,
    useStock: true,
  };
  if (refs.categoryId) body.categoryId = refs.categoryId;
  if (refs.brandId) body.brandId = refs.brandId;
  if (variants.length) {
    body.hasVariants = true;
    body.variants = variants.map((variant) => ({
      name: variant.name,
      sku: variant.sku,
      quantity: variant.stock,
      minQuantity: LOW_STOCK_THRESHOLD,
      purchaseNetCostCents: peso(spec.cost),
    }));
  } else {
    body.quantity = spec.stock;
    body.minQuantity = LOW_STOCK_THRESHOLD;
  }
  return body;
}

/**
 * Per-variant BulkUpsertVariantPricesDto bodies keyed by variant key.
 * `productLists` maps global price-list id → the product's PriceList id.
 */
function variantPriceBodies(spec, productLists, lists) {
  const bodies = new Map();
  for (const variant of spec.variants ?? []) {
    const prices = [
      { global: lists.defaultId, priceCents: peso(variant.price) },
      { global: lists.mayoreoId, priceCents: peso(variant.mayoreo) },
    ];
    if (lists.catalogDefaultId && lists.catalogDefaultId !== lists.defaultId) {
      prices.push({
        global: lists.catalogDefaultId,
        priceCents: peso(variant.price),
      });
    }
    bodies.set(variant.key, {
      prices: prices.map(({ global, priceCents }) => {
        const priceListId = productLists.get(global);
        if (!priceListId) {
          throw new Error(
            `product has no price list for global list ${global}`,
          );
        }
        return { priceListId, priceCents };
      }),
    });
  }
  return bodies;
}

/** Variant id of `variantKey`; null for a simple product. Throws if unknown. */
function variantIdFor(variantKey, variantIds) {
  if (variantKey === null || variantKey === undefined) return null;
  const id = variantIds.get(variantKey);
  if (!id) throw new Error(`no created variant for variantKey "${variantKey}"`);
  return id;
}

function careReviewOf(careReview) {
  if (careReview === undefined || careReview === null) return null;
  // Arrives complete (review, requirement and warning evidence included).
  return structuredClone(careReview);
}

/**
 * Editorial document shape V2 for `spec`: owner from the family binding,
 * evidence and verifiedOn filled, variantKey mapped to the created variant id,
 * no media (publish requires mediaRefs to be empty).
 */
function editorialDocument(spec, vocabulary, variantIds, today) {
  const { families } = indexVocabulary(vocabulary);
  const editorial = spec.editorial;
  const bindings = families.get(editorial.familyCode);
  const evidence = evidenceOf(today);
  const values = editorial.values.map((value) => {
    const binding = bindings.get(value.code);
    if (!binding) throw new Error(`${value.code} not bound to the family`);
    const state = value.state ?? 'known';
    const row = {
      code: value.code,
      owner: binding.owner,
      variantId: variantIdFor(value.variantKey, variantIds),
      state,
    };
    if (state === 'known') {
      row.payload = structuredClone(value.payload);
      row.evidence = { ...evidence };
    } else {
      row.evidence = null;
    }
    return row;
  });
  const facts = (editorial.facts ?? []).map((fact) => ({
    variantId: variantIdFor(fact.variantKey, variantIds),
    presentation: fact.presentation,
    declarations: (fact.declarations ?? []).map((declaration) =>
      (declaration.state ?? 'known') === 'unknown'
        ? { key: declaration.key, state: 'unknown', evidence: null }
        : {
            key: declaration.key,
            state: 'known',
            value: structuredClone(declaration.value),
            basis: declaration.basis,
            evidence: { ...evidence },
          },
    ),
    careReview: careReviewOf(fact.careReview),
  }));
  return {
    schemaVersion: 2,
    commercialTitle: editorial.commercialTitle,
    description: editorial.description,
    mediaRefs: [],
    familyCode: editorial.familyCode,
    values,
    facts,
  };
}

/** Header the publish call needs: review-v1 for care, nothing otherwise. */
const careConfirmationFor = (familyCode) =>
  familyCode === 'care' ? 'review-v1' : null;

/** Idempotency-Key for one editorial write (1..200 characters). */
const idempotencyKeyFor = (runId, productId, operation) =>
  `showcase:${runId}:${productId}:${operation}`;

/** Readiness items as printable lines; variant ids shown as their keys. */
function readinessLines(items, variantKeysById = new Map()) {
  return items.map((item) => {
    const subject = item.variantId
      ? ` [${variantKeysById.get(item.variantId) ?? item.variantId}]`
      : '';
    const what = item.definitionCode ?? item.scope;
    return `${what}${subject} ${item.problem}: ${item.message}`;
  });
}

/** Rows of `products` whose own SKU marks them as showcase products. */
const showcaseProducts = (products) =>
  products.filter((product) => isShowcaseSku(product.sku));

/** Subset of the data set for `--only key1,key2`; throws on unknown keys. */
function selectProducts(products, only) {
  if (!only) return products;
  const wanted = only
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  const known = new Set(products.map((spec) => spec.key));
  const unknown = wanted.filter((key) => !known.has(key));
  if (unknown.length)
    throw new Error(`--only: unknown keys ${unknown.join(', ')}`);
  return products.filter((spec) => wanted.includes(spec.key));
}

module.exports = {
  DECLARATION_KEYS,
  EVIDENCE_SOURCE,
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
  SKU_PREFIX,
  LOW_STOCK_THRESHOLD,
  baseMime,
  careConfirmationFor,
  catalogSkus,
  editorialDocument,
  idempotencyKeyFor,
  indexVocabulary,
  isAllowedImageUrl,
  isShowcaseSku,
  isoDay,
  payloadProblems,
  peso,
  productBody,
  readinessLines,
  selectProducts,
  showcaseProducts,
  validateCatalog,
  variantIdFor,
  variantPriceBodies,
};
