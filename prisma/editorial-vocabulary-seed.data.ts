// Starter v1, NOT an approved production taxonomy. Content is a product decision.
// Extend via reviewed PRs; codes/ids are stable identities, never recycled.
type Definition = {
  code: string;
  label: string;
  type: 'text' | 'boolean' | 'number' | 'single' | 'multi';
  owner: 'product' | 'sellable';
  sortOrder: number;
};
type Option = {
  definitionCode: string;
  type: 'single' | 'multi';
  code: string;
  label: string;
  sortOrder: number;
  archived?: boolean;
};
type Unit = {
  id: string;
  definitionCode: string;
  code: string | null;
  label: string | null;
  sortOrder: number;
};
export interface VocabularySeed {
  family: { id: string; code: string; label: string };
  definitions: Definition[];
  options: Option[];
  units: Unit[];
}
const definition = (
  code: string,
  label: string,
  type: Definition['type'],
  owner: Definition['owner'],
  sortOrder: number,
): Definition => ({ code: `starter.${code}`, label, type, owner, sortOrder });
const option = (
  definitionCode: string,
  type: Option['type'],
  code: string,
  label: string,
): Option => ({ definitionCode, type, code, label, sortOrder: 10 });
const unit = (
  code: string | null,
  label: string | null,
  sortOrder: number,
): Unit => ({
  id: `starter-v1-weight-${code ?? 'none'}`,
  definitionCode: 'starter.weight',
  code,
  label,
  sortOrder,
});
export const STARTER_V1: VocabularySeed = {
  family: {
    id: 'starter-v1-general',
    code: 'starter.general',
    label: 'Starter: General',
  },
  definitions: [
    definition('notes', 'Notes', 'text', 'product', 10),
    definition('reusable', 'Reusable', 'boolean', 'product', 20),
    definition('weight', 'Weight', 'number', 'sellable', 30),
    definition('finish', 'Finish', 'single', 'sellable', 40),
    definition('features', 'Features', 'multi', 'product', 50),
  ],
  options: [
    option('starter.finish', 'single', 'matte', 'Matte'),
    option('starter.features', 'multi', 'washable', 'Washable'),
  ],
  units: [unit(null, null, 0), unit('kg', 'Kilograms', 10)],
};
