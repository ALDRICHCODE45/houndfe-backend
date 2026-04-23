/**
 * SpacesStorageAdapter Unit Tests
 *
 * Tests the DigitalOcean Spaces storage adapter using mocked S3Client.
 */
import { SpacesStorageAdapter } from './spaces-storage.adapter';
import { StorageUploadFailedError } from '../domain/errors';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

// Mock S3Client
jest.mock('@aws-sdk/client-s3', () => {
  const actualModule = jest.requireActual('@aws-sdk/client-s3');
  return {
    ...actualModule,
    S3Client: jest.fn().mockImplementation(() => ({
      send: jest.fn(),
    })),
  };
});

describe('SpacesStorageAdapter', () => {
  let adapter: SpacesStorageAdapter;
  let mockS3Client: jest.Mocked<S3Client>;

  beforeEach(() => {
    mockS3Client = new S3Client({}) as jest.Mocked<S3Client>;
    adapter = new SpacesStorageAdapter(
      mockS3Client,
      'test-bucket',
      'https://test-bucket.nyc3.cdn.digitaloceanspaces.com',
    );
  });

  describe('upload', () => {
    it('should upload file and return key and URL', async () => {
      // Arrange
      mockS3Client.send = jest.fn().mockResolvedValueOnce({});
      const input = {
        buffer: Buffer.from('test file content'),
        key: 'Product/prod-1/uuid-abc.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
      };

      // Act
      const result = await adapter.upload(input);

      // Assert
      expect(result.key).toBe('Product/prod-1/uuid-abc.jpg');
      expect(result.url).toBe(
        'https://test-bucket.nyc3.cdn.digitaloceanspaces.com/Product/prod-1/uuid-abc.jpg',
      );
      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
      expect(mockS3Client.send).toHaveBeenCalledWith(
        expect.any(PutObjectCommand),
      );
    });

    it('should throw StorageUploadFailedError when S3 upload fails', async () => {
      // Arrange
      mockS3Client.send = jest
        .fn()
        .mockRejectedValueOnce(new Error('Network error'));
      const input = {
        buffer: Buffer.from('test'),
        key: 'test.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 100,
      };

      // Act & Assert
      await expect(adapter.upload(input)).rejects.toThrow(
        StorageUploadFailedError,
      );
    });
  });

  describe('delete', () => {
    it('should delete file from storage', async () => {
      // Arrange
      mockS3Client.send = jest.fn().mockResolvedValueOnce({});

      // Act
      await adapter.delete('Product/prod-1/uuid-abc.jpg');

      // Assert
      expect(mockS3Client.send).toHaveBeenCalledTimes(1);
      expect(mockS3Client.send).toHaveBeenCalledWith(
        expect.any(DeleteObjectCommand),
      );
    });

    it('should not throw when deletion fails (logged instead)', async () => {
      // Arrange
      mockS3Client.send = jest
        .fn()
        .mockRejectedValueOnce(new Error('Not found'));

      // Act & Assert
      await expect(adapter.delete('non-existent.jpg')).resolves.toBeUndefined();
    });
  });

  describe('getPublicUrl', () => {
    it('should generate public URL from storage key', () => {
      // Act
      const url = adapter.getPublicUrl('Product/prod-1/uuid-abc.jpg');

      // Assert
      expect(url).toBe(
        'https://test-bucket.nyc3.cdn.digitaloceanspaces.com/Product/prod-1/uuid-abc.jpg',
      );
    });
  });
});
