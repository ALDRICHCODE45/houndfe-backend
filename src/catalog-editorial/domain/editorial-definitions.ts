import type { Owner } from './document';

export type PersistedEditorialDefinition = { id: string; code: string } & (
  | { type: 'text' | 'boolean' }
  | { type: 'number'; units: (string | null)[] }
  | { type: 'single' | 'multi'; options: { code: string; archived: boolean }[] }
);

/** Company-wide vocabulary observation, not scoped DocumentAuthority or an auth lease. */
export interface EditorialDefinitionsSnapshot {
  families: {
    id: string;
    code: string;
    bindings: { definitionId: string; owner: Owner }[];
  }[];
  definitions: PersistedEditorialDefinition[];
}
