import { InvalidArgumentError } from '../../shared/domain/domain-error';

export interface ServiceCredentialProps {
  id: string;
  tenantId: string;
  name: string;
  hashedKey: string;
  scopes: string[];
  isActive: boolean;
  lastUsedAt: Date | null;
  rateLimit: number;
  createdAt: Date;
  revokedAt: Date | null;
}

export class ServiceCredential {
  public readonly id: string;
  public readonly tenantId: string;
  public name: string;
  public hashedKey: string;
  public scopes: string[];
  public isActive: boolean;
  public lastUsedAt: Date | null;
  public rateLimit: number;
  public readonly createdAt: Date;
  public revokedAt: Date | null;

  private constructor(props: ServiceCredentialProps) {
    this.id = props.id;
    this.tenantId = props.tenantId;
    this.name = props.name;
    this.hashedKey = props.hashedKey;
    this.scopes = props.scopes;
    this.isActive = props.isActive;
    this.lastUsedAt = props.lastUsedAt;
    this.rateLimit = props.rateLimit;
    this.createdAt = props.createdAt;
    this.revokedAt = props.revokedAt;
  }

  static create(params: {
    id: string;
    tenantId: string;
    name: string;
    hashedKey: string;
    scopes: string[];
    isActive?: boolean;
    lastUsedAt?: Date | null;
    rateLimit?: number;
    revokedAt?: Date | null;
  }): ServiceCredential {
    const tenantId = params.tenantId?.trim();
    if (!tenantId) {
      throw new InvalidArgumentError('Service credential tenantId is required');
    }

    const name = params.name?.trim();
    if (!name) {
      throw new InvalidArgumentError('Service credential name is required');
    }

    const hashedKey = params.hashedKey?.trim();
    if (!hashedKey) {
      throw new InvalidArgumentError(
        'Service credential hashedKey is required',
      );
    }

    const scopes = Array.from(
      new Set(params.scopes.map((scope) => scope.trim()).filter(Boolean)),
    );
    if (scopes.length === 0) {
      throw new InvalidArgumentError(
        'Service credential must have at least one scope',
      );
    }

    const rateLimit = params.rateLimit ?? 60;
    if (rateLimit <= 0) {
      throw new InvalidArgumentError(
        'Service credential rateLimit must be positive',
      );
    }

    const now = new Date();

    return new ServiceCredential({
      id: params.id,
      tenantId,
      name,
      hashedKey,
      scopes,
      isActive: params.isActive ?? true,
      lastUsedAt: params.lastUsedAt ?? null,
      rateLimit,
      createdAt: now,
      revokedAt: params.revokedAt ?? null,
    });
  }

  static fromPersistence(data: ServiceCredentialProps): ServiceCredential {
    return new ServiceCredential({
      ...data,
      name: data.name.trim(),
      hashedKey: data.hashedKey.trim(),
      scopes: [...data.scopes],
      lastUsedAt: data.lastUsedAt ? new Date(data.lastUsedAt) : null,
      createdAt: new Date(data.createdAt),
      revokedAt: data.revokedAt ? new Date(data.revokedAt) : null,
    });
  }

  hasScope(scope: string): boolean {
    return this.scopes.includes(scope.trim());
  }

  toPersistence(): ServiceCredentialProps {
    return {
      id: this.id,
      tenantId: this.tenantId,
      name: this.name,
      hashedKey: this.hashedKey,
      scopes: [...this.scopes],
      isActive: this.isActive,
      lastUsedAt: this.lastUsedAt,
      rateLimit: this.rateLimit,
      createdAt: this.createdAt,
      revokedAt: this.revokedAt,
    };
  }
}
