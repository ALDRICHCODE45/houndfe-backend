// Ops › showcase catalog › toy/hygiene/accessory/habitat content helpers.
// Builds the L5 editorial shape (odd/tasks/prod-showcase-catalog.md): a
// product with variants repeats every value and fact once per variant
// (variantKey set); a simple product uses variantKey null.
'use strict';

const one = (code, value) => ({ code, payload: { type: 'single', value } });
const many = (code, value) => ({ code, payload: { type: 'multi', value } });
const num = (code, value, unit) => ({
  code,
  payload: { type: 'number', value, unit },
});
const range = (code, min, max, unit) => ({
  code,
  payload: { type: 'range', min, max, unit },
});
const text = (code, value) => ({ code, payload: { type: 'text', value } });
const bool = (code, value) => ({ code, payload: { type: 'boolean', value } });

/** Known declaration; the engine adds the evidence. */
const fact = (key, value, basis) => ({ key, state: 'known', value, basis });

// Common declaration sets.
const notElectrical = [
  fact('electricalApplies', false, 'El producto no usa corriente eléctrica.'),
  fact('relevantEquipmentCodes', [], 'Sin especificaciones eléctricas.'),
];
const capacityIrrelevant = [
  fact(
    'capacityDeterminesChoice',
    false,
    'La capacidad no decide la compra de este accesorio.',
  ),
  fact('relevantCapacityCodes', [], 'Sin capacidades relevantes.'),
];
const fitIrrelevant = [
  fact(
    'fitDeterminesChoice',
    false,
    'No se elige por medidas de cuello, pecho o espalda.',
  ),
  fact('relevantFitCodes', [], 'Sin medidas de ajuste relevantes.'),
];

/** Pesos rounded to whole units, the store's price style. */
const mx = (amount) => Math.round(amount);

/**
 * Editorial block. `values`/`declarations` are shared; `variants` (optional)
 * is `[{ key, presentation, values?, declarations? }]` with the per-variant
 * extras (a per-variant declaration replaces the shared one with its key).
 */
function editorial({
  familyCode,
  commercialTitle,
  description,
  values,
  declarations,
  presentation,
  variants,
}) {
  const subjects = variants?.length
    ? variants
    : [{ key: null, presentation, values: [], declarations: [] }];
  const outValues = [];
  const facts = [];
  for (const subject of subjects) {
    const variantKey = subject.key;
    for (const value of [...values, ...(subject.values ?? [])])
      outValues.push({ ...value, variantKey });
    const own = subject.declarations ?? [];
    const ownKeys = new Set(own.map((item) => item.key));
    facts.push({
      variantKey,
      presentation: subject.presentation,
      declarations: [
        ...declarations.filter((item) => !ownKeys.has(item.key)),
        ...own,
      ],
    });
  }
  return {
    familyCode,
    commercialTitle,
    description,
    values: outValues,
    facts,
  };
}

/** Image entry (engine downloads and uploads it to Spaces). */
const image = (url, credit, license, sourcePage) => ({
  url,
  credit,
  license,
  sourcePage,
});

module.exports = {
  bool,
  capacityIrrelevant,
  editorial,
  fact,
  fitIrrelevant,
  image,
  many,
  mx,
  notElectrical,
  num,
  one,
  range,
  text,
};
