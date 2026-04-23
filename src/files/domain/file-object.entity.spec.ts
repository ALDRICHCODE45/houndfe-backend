/**
 * FileObject Entity Unit Tests
 *
 * Tests the FileObject domain entity creation and validation.
 */
import { FileObject } from './file-object.entity';

describe('FileObject Entity', () => {
  describe('create', () => {
    it('should create a valid FileObject with all required fields', () => {
      // Arrange
      const data = {
        id: 'file-123',
        storageKey: 'Product/prod-1/uuid-abc.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 102400,
        ownerType: 'Product',
        ownerId: 'prod-1',
        uploadedBy: 'user-1',
        createdAt: new Date('2026-04-22T00:00:00Z'),
      };

      // Act
      const fileObject = FileObject.create(data);

      // Assert
      expect(fileObject.id).toBe('file-123');
      expect(fileObject.storageKey).toBe('Product/prod-1/uuid-abc.jpg');
      expect(fileObject.url).toBe(
        'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
      );
      expect(fileObject.mimeType).toBe('image/jpeg');
      expect(fileObject.sizeBytes).toBe(102400);
      expect(fileObject.ownerType).toBe('Product');
      expect(fileObject.ownerId).toBe('prod-1');
      expect(fileObject.uploadedBy).toBe('user-1');
      expect(fileObject.createdAt).toEqual(new Date('2026-04-22T00:00:00Z'));
    });

    it('should create FileObject with optional fields as undefined', () => {
      // Arrange
      const data = {
        id: 'file-456',
        storageKey: 'orphan/uuid-xyz.pdf',
        url: 'https://cdn.example.com/orphan/uuid-xyz.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 204800,
        createdAt: new Date('2026-04-22T01:00:00Z'),
      };

      // Act
      const fileObject = FileObject.create(data);

      // Assert
      expect(fileObject.id).toBe('file-456');
      expect(fileObject.storageKey).toBe('orphan/uuid-xyz.pdf');
      expect(fileObject.ownerType).toBeUndefined();
      expect(fileObject.ownerId).toBeUndefined();
      expect(fileObject.uploadedBy).toBeUndefined();
    });
  });
});
