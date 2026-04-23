import { FilesController } from './files.controller';
import type { FilesService } from './files.service';
import { FileObject } from './domain/file-object.entity';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

// ── Minimal mocks ──────────────────────────────────────────────────────

function makeMockFilesService() {
  return {
    uploadAndRegister: jest.fn(),
    findById: jest.fn(),
    delete: jest.fn(),
  } as any;
}

function makeMockUser(userId: string): AuthenticatedUser {
  return { userId, email: `${userId}@test.com`, organizationId: 'org-123' };
}

describe('FilesController', () => {
  let service: ReturnType<typeof makeMockFilesService>;
  let controller: FilesController;

  beforeEach(() => {
    service = makeMockFilesService();
    controller = new FilesController(service);
  });

  describe('POST /files', () => {
    it('should upload file and return FileObject metadata', async () => {
      // Arrange
      const mockFile: Express.Multer.File = {
        buffer: Buffer.from('test file content'),
        originalname: 'test.jpg',
        mimetype: 'image/jpeg',
        size: 1024,
      } as Express.Multer.File;

      const mockUser = makeMockUser('user-123');

      const expectedResult = FileObject.create({
        id: 'file-123',
        storageKey: 'orphan/abc-123.jpg',
        url: 'https://spaces.example.com/orphan/abc-123.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        uploadedBy: 'user-123',
        createdAt: new Date('2026-04-22T12:00:00Z'),
      });

      service.uploadAndRegister.mockResolvedValue(expectedResult);

      // Act
      const result = await controller.upload(mockFile, mockUser);

      // Assert
      expect(result).toEqual(expectedResult);
      expect(service.uploadAndRegister).toHaveBeenCalledWith({
        buffer: mockFile.buffer,
        mimeType: mockFile.mimetype,
        originalName: mockFile.originalname,
        uploadedBy: mockUser.userId,
      });
    });
  });

  describe('GET /files/:id', () => {
    it('should return file metadata by ID', async () => {
      // Arrange
      const fileId = 'file-123';
      const expectedFile = FileObject.create({
        id: fileId,
        storageKey: 'orphan/abc-123.jpg',
        url: 'https://spaces.example.com/orphan/abc-123.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        createdAt: new Date('2026-04-22T12:00:00Z'),
      });

      service.findById.mockResolvedValue(expectedFile);

      // Act
      const result = await controller.findById(fileId);

      // Assert
      expect(result).toEqual(expectedFile);
      expect(service.findById).toHaveBeenCalledWith(fileId);
    });
  });

  describe('DELETE /files/:id', () => {
    it('should delete file by ID', async () => {
      // Arrange
      const fileId = 'file-123';
      service.delete.mockResolvedValue(undefined);

      // Act
      await controller.remove(fileId);

      // Assert
      expect(service.delete).toHaveBeenCalledWith(fileId);
    });
  });
});
