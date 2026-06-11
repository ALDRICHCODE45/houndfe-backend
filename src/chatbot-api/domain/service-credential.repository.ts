import { ServiceCredential } from './service-credential.entity';

export interface IServiceCredentialRepository {
  findByHashedKey(hashedKey: string): Promise<ServiceCredential | null>;
  touchLastUsedAt(id: string, touchedAt?: Date): Promise<void>;
}

export const SERVICE_CREDENTIAL_REPOSITORY = Symbol(
  'SERVICE_CREDENTIAL_REPOSITORY',
);
