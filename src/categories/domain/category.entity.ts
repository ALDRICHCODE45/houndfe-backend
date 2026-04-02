/**
 * ENTITY: Category
 *
 * Simple entity with unique name constraint.
 * Deleting a category leaves products with categoryId = null (SetNull in Prisma).
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export class Category {
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

  static create(id: string, name: string): Category {
    if (!name?.trim()) {
      throw new InvalidArgumentError('Category name is required');
    }
    const cleanName = name.trim();
    if (cleanName.length > 50) {
      throw new InvalidArgumentError(
        'Category name must have maximum 50 characters',
      );
    }
    const now = new Date();
    return new Category(id, cleanName, now, now);
  }

  static fromPersistence(data: {
    id: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
  }): Category {
    return new Category(
      data.id,
      data.name,
      new Date(data.createdAt),
      new Date(data.updatedAt),
    );
  }

  updateName(newName: string): void {
    if (!newName?.trim()) {
      throw new InvalidArgumentError('Category name is required');
    }
    const cleanName = newName.trim();
    if (cleanName.length > 50) {
      throw new InvalidArgumentError(
        'Category name must have maximum 50 characters',
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
