import {
  decodeHistoricalVocabularyGraph,
  type HistoricalVocabularyGraph,
} from './editorial-vocabulary-historical-graph';
import type { VocabularyV1 } from './editorial-vocabulary-projection-v1';
import { indexVocabularyV1Bindings } from './editorial-vocabulary-selection-v1';

type Definition = HistoricalVocabularyGraph['definitions'][number];

function invalid(): never {
  throw new TypeError('Invalid historical vocabulary V1');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function order(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) invalid();
  return value;
}

function pending(value: unknown, key: string): boolean {
  if (value === null) return true;
  if (value === undefined) invalid();
  const row = record(value);
  return Object.keys(row).length === 1 && row[key] === 'pending';
}

// Persisted JSONB classification, deliberately NOT V2 numeric admission.
function numericPending(value: unknown): boolean {
  if (pending(value, 'status')) return true;
  const row = record(value);
  if (
    row.status !== 'resolved' ||
    typeof row.magnitude !== 'string' ||
    row.magnitude.replace(/^ +| +$/g, '') === '' ||
    typeof row.integer !== 'boolean' ||
    typeof row.lowerInclusive !== 'boolean' ||
    typeof row.upperInclusive !== 'boolean' ||
    ![row.lower, row.upper].every(
      (bound) =>
        bound === null || (typeof bound === 'number' && Number.isFinite(bound)),
    )
  )
    invalid();
  return false;
}

function unique<T>(seen: Set<T>, value: T): T {
  if (seen.has(value)) invalid();
  seen.add(value);
  return value;
}

function child(
  value: unknown,
  definition: Definition,
): Record<string, unknown> {
  const row = record(value);
  if (
    row.definitionId !== definition.id ||
    row.definitionType !== definition.type
  )
    invalid();
  return row;
}

/** Dormant historical boundary; provenance/completeness remain caller obligations. */
export function projectHistoricalVocabularyV1(input: unknown): VocabularyV1 {
  const graph = decodeHistoricalVocabularyGraph(input);
  const { originallyBound, retained } = indexVocabularyV1Bindings(
    graph.families,
  );
  const families = graph.families
    .filter((family) => family.minimumContractVersion === 1)
    .map(({ id, code, label, bindings }) => ({
      id,
      code,
      label,
      bindings: bindings.map((binding) => {
        if (!pending(binding.policy, 'route')) invalid();
        const { definitionId, definitionCode, owner, sortOrder } = binding;
        return { definitionId, definitionCode, owner, sortOrder };
      }),
    }));
  const definitions: VocabularyV1['definitions'] = [];
  const unitIds = new Set<string>();
  for (const definition of graph.definitions) {
    const kept = retained.has(definition.id);
    if (!kept && originallyBound.has(definition.id)) continue;
    if (definition.type === 'range') {
      if (kept) invalid();
      continue;
    }
    if (
      definition.type === 'number' &&
      !numericPending(definition.numericPolicy)
    ) {
      if (kept) invalid();
      continue;
    }
    const { id, code, label, type } = definition;
    switch (type) {
      case 'number': {
        const codes = new Set<string | null>();
        const units = definition.units.map((value) => {
          const row = child(value, definition);
          unique(unitIds, text(row.id));
          return {
            code: unique(codes, nullableText(row.unitCode)),
            label: nullableText(row.label),
            sortOrder: order(row.sortOrder),
          };
        });
        definitions.push({ id, code, label, type, units });
        break;
      }
      case 'single':
      case 'multi': {
        const codes = new Set<string>();
        const options = definition.options.map((value) => {
          const row = child(value, definition);
          const archivedAt = nullableText(row.archivedAt);
          return {
            code: unique(codes, text(row.code)),
            label: text(row.label),
            archived: archivedAt !== null,
            sortOrder: order(row.sortOrder),
          };
        });
        definitions.push({ id, code, label, type, options });
        break;
      }
      case 'text':
      case 'boolean':
        definitions.push({ id, code, label, type });
    }
  }
  return { families, definitions };
}
