import { EditorialDocumentShapeError } from './editorial-document-shape-error';
import {
  parseDocumentShapeV2,
  type DocumentShapeV2,
} from './editorial-document-shape-v2';

// Static wire unions from facts contract §1, not current vocabulary membership.
const dimensionCodes = new Set([
  'measure.dimensions.external_length',
  'measure.dimensions.external_width',
  'measure.dimensions.external_height',
  'measure.dimensions.external_diameter',
  'measure.dimensions.internal_length',
  'measure.dimensions.internal_width',
  'measure.dimensions.internal_height',
  'measure.dimensions.internal_diameter',
]);
const fitCodes = new Set([
  'measure.fit.neck',
  'measure.fit.chest',
  'measure.fit.back_length',
]);
const capacityCodes = new Set([
  'measure.capacity.container',
  'measure.capacity.habitat_usable_volume',
]);
const equipmentCodes = new Set([
  'measure.equipment.power',
  'measure.equipment.voltage',
  'measure.equipment.frequency',
  'measure.equipment.flow',
  'measure.equipment.temperature',
]);

/** Historical readability only; neither fresh admission nor mode classification. */
export function isRecognizableDocumentV2(
  input: unknown,
): input is DocumentShapeV2 {
  let document: DocumentShapeV2;
  try {
    document = parseDocumentShapeV2(input);
  } catch (error) {
    if (error instanceof EditorialDocumentShapeError) return false;
    throw error;
  }
  return document.facts.every((row) =>
    row.declarations.every((declaration) => {
      if (declaration.state === 'unknown') return true;
      switch (declaration.key) {
        case 'relevantDimensionCodes':
          return declaration.value.codes.every((code) =>
            dimensionCodes.has(code),
          );
        case 'relevantFitCodes':
          return declaration.value.every((code) => fitCodes.has(code));
        case 'relevantCapacityCodes':
          return declaration.value.every((code) => capacityCodes.has(code));
        case 'relevantEquipmentCodes':
          return declaration.value.every((code) => equipmentCodes.has(code));
        default:
          return true;
      }
    }),
  );
}
