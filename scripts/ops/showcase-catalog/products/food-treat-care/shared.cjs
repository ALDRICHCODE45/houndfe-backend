'use strict';
// Builders for the L5 data contract (food, treat and care families).
// Values and declarations carry no evidence: the engine fills sourceRef/verifiedOn
// and owner. careReview is nested and needs its own evidence, so it ships complete.

const value = (code, payload) => ({ code, payload, variantKey: null });
const single = (code, option) => value(code, { type: 'single', value: option });
const multi = (code, options) => value(code, { type: 'multi', value: options });
const num = (code, amount, unit) =>
  value(code, { type: 'number', value: amount, unit });
const range = (code, min, max, unit) =>
  value(code, { type: 'range', min, max, unit });
const text = (code, body) => value(code, { type: 'text', value: body });

// Every production binding is sellable: a product with variants needs each value
// once per variant (null is rejected), a simple product uses variantKey null.
// `extra` maps a variant key to the values that differ for that variant.
function perVariant(values, variantKeys, extra = {}) {
  return variantKeys.flatMap((key) =>
    [...values, ...(extra[key] ?? [])].map((item) => ({
      ...item,
      variantKey: key,
    })),
  );
}

const decl = (key, declared, basis = 'Dice el empaque') => ({
  key,
  state: 'known',
  value: declared,
  basis,
});

function fact(variantKey, presentation, declarations, careReview) {
  const row = { variantKey, presentation, declarations };
  if (careReview !== undefined) row.careReview = careReview;
  return row;
}

const VERIFIED_ON = '2026-11-09';
const evidence = (sourceRef) => [{ sourceRef, verifiedOn: VERIFIED_ON }];

// A prepared, identified care review that readiness accepts: every requirement
// satisfied with evidence, every warning private_only with evidence.
function careReview({ intendedUse, basis, sourceRef, requirements, warnings }) {
  return {
    state: 'prepared',
    jurisdiction: 'MX',
    intendedUse,
    determination: 'identified',
    evidence: evidence(sourceRef),
    basis,
    requirements: requirements.map((item) => ({
      key: item.key,
      description: item.description,
      disposition: 'satisfied',
      evidence: evidence(sourceRef),
      basis: item.basis,
    })),
    warnings: warnings.map((item) => ({
      key: item.key,
      requirementKeys: item.requirementKeys,
      text: item.text,
      disclosure: 'private_only',
      evidence: evidence(sourceRef),
      handlingBasis: item.handlingBasis,
    })),
  };
}

// Wikimedia Commons image entry; `file` is the Commons file name.
function commons(url, file, credit, license) {
  return {
    url,
    credit,
    license,
    sourcePage: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(
      file.replace(/ /g, '_'),
    )
      .replace(/%2C/g, ',')
      .replace(/%28/g, '(')
      .replace(/%29/g, ')')}`,
  };
}

module.exports = {
  single,
  multi,
  num,
  range,
  text,
  perVariant,
  decl,
  fact,
  careReview,
  commons,
};
