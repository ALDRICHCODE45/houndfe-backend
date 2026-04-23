/**
 * IFileRepository - Port for FileObject persistence.
 *
 * Repository abstraction for FileObject aggregate.
 */
import { FileObject } from './file-object.entity';

export const FILE_REPOSITORY = Symbol('FILE_REPOSITORY');

export interface IFileRepository {
  /**
   * Save a FileObject to persistence.
   */
  save(file: FileObject): Promise<FileObject>;

  /**
   * Find a FileObject by ID.
   * @returns FileObject or null if not found
   */
  findById(id: string): Promise<FileObject | null>;

  /**
   * Find multiple FileObjects by IDs.
   */
  findByIds(ids: string[]): Promise<FileObject[]>;

  /**
   * Delete a FileObject by ID.
   * @throws FileNotFoundError if not found
   */
  delete(id: string): Promise<void>;

  /**
   * Find FileObjects by owner.
   */
  findByOwner(ownerType: string, ownerId: string): Promise<FileObject[]>;
}
