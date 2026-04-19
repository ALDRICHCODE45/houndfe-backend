import { InvalidArgumentError } from '../../shared/domain/domain-error';

export class Brand {
  public readonly id: string;
  public name: string;
  public readonly createdAt: Date;
  public updatedAt: Date;

  private constructor(
    id: string,
    name: string,
    createdAt: Date,
    updatedAt: Date,
  ) {
    this.id = id;
    this.name = name;
    this.createdAt = createdAt;
    this.updatedAt = updatedAt;
  }

  static create(id: string, name: string): Brand {
    if (!name?.trim()) {
      throw new InvalidArgumentError('Brand name is required');
    }
    const cleanName = name.trim();
    if (cleanName.length < 2) {
      throw new InvalidArgumentError(
        'Brand name must have at least 2 characters',
      );
    }
    if (cleanName.length > 50) {
      throw new InvalidArgumentError(
        'Brand name must have maximum 50 characters',
      );
    }
    const now = new Date();
    return new Brand(id, cleanName, now, now);
  }

  static fromPersistence(data: {
    id: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
  }): Brand {
    return new Brand(
      data.id,
      data.name,
      new Date(data.createdAt),
      new Date(data.updatedAt),
    );
  }

  updateName(newName: string): void {
    if (!newName?.trim()) {
      throw new InvalidArgumentError('Brand name is required');
    }
    const cleanName = newName.trim();
    if (cleanName.length < 2) {
      throw new InvalidArgumentError(
        'Brand name must have at least 2 characters',
      );
    }
    if (cleanName.length > 50) {
      throw new InvalidArgumentError(
        'Brand name must have maximum 50 characters',
      );
    }
    this.name = cleanName;
    this.updatedAt = new Date();
  }

  toResponse() {
    return {
      id: this.id,
      name: this.name,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
