import { projectDefinitionFamilies } from '../domain/contextual-document';
import { readLockedEditorialDefinitions } from './prisma-locked-editorial-definitions';
import { readLockedEditorialReferences } from './prisma-locked-editorial-references';
import {
  createPrismaEditorialWriteAuthority,
  type EditorialDocumentPreparation,
  type EditorialWriteAuthorityFactory,
} from './prisma-editorial-write-authority';

function selectedAssets(documents: readonly unknown[]): string[] {
  return documents.flatMap((document) => {
    if (!document || typeof document !== 'object') return [];
    const media: unknown = Object.getOwnPropertyDescriptor(
      document,
      'mediaRefs',
    )?.value;
    return Array.isArray(media)
      ? media.filter((id: unknown): id is string => typeof id === 'string')
      : [];
  });
}

/** Internal opt-in factory; no module registration or HTTP activation. */
export const createCoordinatedEditorialWriteAuthority: EditorialWriteAuthorityFactory =
  (tx) => {
    const authority = createPrismaEditorialWriteAuthority(tx, () => ({
      resolve: async (scope) => {
        // Observe real sources even for empty/replay attempts, after capability/gate.
        const references = await readLockedEditorialReferences(tx, scope, []);
        await readLockedEditorialDefinitions(tx, []);
        return { ...references, families: [] };
      },
    }));
    const prepareDocuments: EditorialDocumentPreparation = async ({
      scope,
      documents,
      mode,
    }) => {
      const references = await readLockedEditorialReferences(
        tx,
        scope,
        selectedAssets(documents),
      );
      // Stored writes retain the core's selected definitions and conservation site.
      const families =
        mode === 'stored'
          ? []
          : projectDefinitionFamilies(
              await readLockedEditorialDefinitions(tx, documents),
            );
      return { ...references, families };
    };
    return {
      createAuthority: authority.createAuthority,
      saveAuthority: authority.saveAuthority,
      publishAuthority: authority.publishAuthority,
      discardAuthority: authority.discardAuthority,
      prepareDocuments,
    };
  };
