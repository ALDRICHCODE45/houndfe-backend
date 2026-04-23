/**
 * FilesService Unit Tests
 *
 * Tests the FilesService orchestration with mocked ports.
 */
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FilesService } from './files.service';
import { IStoragePort } from './domain/storage.port';
import { IFileRepository } from './domain/file.repository';
import { FileObject } from './domain/file-object.entity';
import {
  FileNotFoundError,
  FileTooLargeError,
  UnsupportedMediaTypeError,
} from './domain/errors';
import { FileUploadedEvent } from './domain/events/file-uploaded.event';

describe('FilesService', () => {
  let service: FilesService;
  let mockStoragePort: jest.Mocked<IStoragePort>;
  let mockFileRepository: jest.Mocked<IFileRepository>;
  let mockEventEmitter: jest.Mocked<EventEmitter2>;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    mockStoragePort = {
      upload: jest.fn(),
      delete: jest.fn(),
      getPublicUrl: jest.fn(),
    };

    mockFileRepository = {
      save: jest.fn(),
      findById: jest.fn(),
      findByIds: jest.fn(),
      delete: jest.fn(),
      findByOwner: jest.fn(),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    } as any;

    mockConfigService = {
      get: jest.fn().mockReturnValue(10), // Default 10MB
    } as any;

    service = new FilesService(
      mockStoragePort,
      mockFileRepository,
      mockEventEmitter,
      mockConfigService,
    );
  });

  describe('uploadAndRegister', () => {
    it('should upload file to storage and save to repository', async () => {
      // Arrange
      const buffer = Buffer.from('test content');
      const input = {
        buffer,
        mimeType: 'image/jpeg',
        originalName: 'test.jpg',
        ownerType: 'Product',
        ownerId: 'prod-1',
        uploadedBy: 'user-1',
      };

      mockStoragePort.upload.mockResolvedValueOnce({
        key: 'Product/prod-1/uuid-abc.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
      });

      const savedFile = FileObject.create({
        id: 'file-123',
        storageKey: 'Product/prod-1/uuid-abc.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: buffer.length,
        ownerType: 'Product',
        ownerId: 'prod-1',
        uploadedBy: 'user-1',
        createdAt: new Date(),
      });

      mockFileRepository.save.mockResolvedValueOnce(savedFile);

      // Act
      const result = await service.uploadAndRegister(input);

      // Assert
      expect(result.id).toBe('file-123');
      expect(mockStoragePort.upload).toHaveBeenCalledTimes(1);
      expect(mockFileRepository.save).toHaveBeenCalledTimes(1);
      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'file.uploaded',
        expect.any(FileUploadedEvent),
      );
    });

    it('should delete from storage if repository save fails', async () => {
      // Arrange
      const buffer = Buffer.from('test content');
      const input = {
        buffer,
        mimeType: 'image/jpeg',
        originalName: 'test.jpg',
      };

      mockStoragePort.upload.mockResolvedValueOnce({
        key: 'orphan/uuid-xyz.jpg',
        url: 'https://cdn.example.com/orphan/uuid-xyz.jpg',
      });

      mockFileRepository.save.mockRejectedValueOnce(new Error('DB Error'));

      // Act & Assert
      await expect(service.uploadAndRegister(input)).rejects.toThrow(
        'DB Error',
      );
      expect(mockStoragePort.delete).toHaveBeenCalledWith(
        'orphan/uuid-xyz.jpg',
      );
    });

    it('should reject file exceeding size limit', async () => {
      // Arrange - Create a buffer larger than 10MB
      const largeBuffer = Buffer.alloc(11 * 1024 * 1024); // 11MB
      const input = {
        buffer: largeBuffer,
        mimeType: 'image/jpeg',
        originalName: 'large.jpg',
      };

      // Act & Assert
      await expect(service.uploadAndRegister(input)).rejects.toThrow(
        FileTooLargeError,
      );
      expect(mockStoragePort.upload).not.toHaveBeenCalled();
    });

    it('should reject file with invalid MIME type', async () => {
      // Arrange
      const buffer = Buffer.from('test content');
      const input = {
        buffer,
        mimeType: 'application/pdf', // Not an allowed image type
        originalName: 'document.pdf',
      };

      // Act & Assert
      await expect(service.uploadAndRegister(input)).rejects.toThrow(
        UnsupportedMediaTypeError,
      );
      expect(mockStoragePort.upload).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('should return FileObject when found', async () => {
      // Arrange
      const fileObject = FileObject.create({
        id: 'file-123',
        storageKey: 'Product/prod-1/uuid-abc.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        createdAt: new Date(),
      });

      mockFileRepository.findById.mockResolvedValueOnce(fileObject);

      // Act
      const result = await service.findById('file-123');

      // Assert
      expect(result.id).toBe('file-123');
    });

    it('should throw FileNotFoundError when not found', async () => {
      // Arrange
      mockFileRepository.findById.mockResolvedValueOnce(null);

      // Act & Assert
      await expect(service.findById('non-existent')).rejects.toThrow(
        FileNotFoundError,
      );
    });
  });

  describe('delete', () => {
    it('should delete from repository and storage', async () => {
      // Arrange
      const fileObject = FileObject.create({
        id: 'file-123',
        storageKey: 'Product/prod-1/uuid-abc.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        createdAt: new Date(),
      });

      mockFileRepository.findById.mockResolvedValueOnce(fileObject);
      mockFileRepository.delete.mockResolvedValueOnce();
      mockStoragePort.delete.mockResolvedValueOnce();

      // Act
      await service.delete('file-123');

      // Assert
      expect(mockFileRepository.delete).toHaveBeenCalledWith('file-123');
      expect(mockStoragePort.delete).toHaveBeenCalledWith(
        'Product/prod-1/uuid-abc.jpg',
      );
    });
  });
});
