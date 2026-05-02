/**
 * PrismaFileRepository Unit Tests
 *
 * Tests the Prisma FileObject repository with mocked PrismaService.
 */
import { PrismaFileRepository } from './prisma-file.repository';
import { FileNotFoundError } from '../domain/errors';
import { FileObject } from '../domain/file-object.entity';

describe('PrismaFileRepository', () => {
  let repository: PrismaFileRepository;
  let mockPrismaService: any;
  let mockTenantPrisma: any;

  beforeEach(() => {
    mockPrismaService = {
      fileObject: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        delete: jest.fn(),
      },
    };

    mockTenantPrisma = {
      getClient: jest.fn().mockReturnValue(mockPrismaService),
    };

    repository = new PrismaFileRepository(mockTenantPrisma);
  });

  describe('save', () => {
    it('should save FileObject and return persisted entity', async () => {
      // Arrange
      const fileObject = FileObject.create({
        id: 'file-123',
        storageKey: 'Product/prod-1/uuid-abc.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 102400,
        ownerType: 'Product',
        ownerId: 'prod-1',
        uploadedBy: 'user-1',
        createdAt: new Date('2026-04-22T00:00:00Z'),
      });

      mockPrismaService.fileObject.create.mockResolvedValueOnce({
        id: 'file-123',
        storageKey: 'Product/prod-1/uuid-abc.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 102400,
        ownerType: 'Product',
        ownerId: 'prod-1',
        uploadedBy: 'user-1',
        createdAt: new Date('2026-04-22T00:00:00Z'),
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      });

      // Act
      const result = await repository.save(fileObject);

      // Assert
      expect(result.id).toBe('file-123');
      expect(mockTenantPrisma.getClient).toHaveBeenCalled();
      expect(mockPrismaService.fileObject.create).toHaveBeenCalledWith({
        data: {
          id: 'file-123',
          storageKey: 'Product/prod-1/uuid-abc.jpg',
          url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 102400,
          ownerType: 'Product',
          ownerId: 'prod-1',
          uploadedBy: 'user-1',
          createdAt: new Date('2026-04-22T00:00:00Z'),
        },
      });
    });
  });

  describe('findById', () => {
    it('should return FileObject when found', async () => {
      // Arrange
      mockPrismaService.fileObject.findUnique.mockResolvedValueOnce({
        id: 'file-123',
        storageKey: 'Product/prod-1/uuid-abc.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 102400,
        ownerType: 'Product',
        ownerId: 'prod-1',
        uploadedBy: 'user-1',
        createdAt: new Date('2026-04-22T00:00:00Z'),
        updatedAt: new Date('2026-04-22T00:00:00Z'),
      });

      // Act
      const result = await repository.findById('file-123');

      // Assert
      expect(result).not.toBeNull();
      expect(result!.id).toBe('file-123');
    });

    it('should return null when not found', async () => {
      // Arrange
      mockPrismaService.fileObject.findUnique.mockResolvedValueOnce(null);

      // Act
      const result = await repository.findById('non-existent');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete FileObject', async () => {
      // Arrange
      mockPrismaService.fileObject.delete.mockResolvedValueOnce({});

      // Act
      await repository.delete('file-123');

      // Assert
      expect(mockPrismaService.fileObject.delete).toHaveBeenCalledWith({
        where: { id: 'file-123' },
      });
    });

    it('should throw FileNotFoundError when file not found', async () => {
      // Arrange
      mockPrismaService.fileObject.delete.mockRejectedValueOnce({
        code: 'P2025',
      });

      // Act & Assert
      await expect(repository.delete('non-existent')).rejects.toThrow(
        FileNotFoundError,
      );
    });
  });
});
