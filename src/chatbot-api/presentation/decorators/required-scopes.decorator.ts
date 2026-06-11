import { SetMetadata } from '@nestjs/common';
import { ServiceCredential } from '../../domain/service-credential.entity';

export const REQUIRED_SCOPES_KEY = 'required_scopes';

function normalizeScopes(scopes: string[]): string[] {
  return Array.from(
    new Set(scopes.map((scope) => scope.trim()).filter(Boolean)),
  );
}

export const RequiredScopes = (...scopes: string[]) =>
  SetMetadata(REQUIRED_SCOPES_KEY, normalizeScopes(scopes));

export function credentialHasRequiredScopes(
  credential: ServiceCredential,
  requiredScopes: string[],
): boolean {
  return normalizeScopes(requiredScopes).every((scope) =>
    credential.hasScope(scope),
  );
}
