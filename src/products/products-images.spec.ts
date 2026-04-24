/**
 * ProductsService - Product Image Upload Tests
 *
 * Tests multipart image upload scenarios (R6, R7):
 * - S15: Upload product image successfully
 * - S16: Upload multiple product images
 * - S18: Upload variant image successfully
 * - S19: Variant doesn't belong to product → error
 */
import { ProductsService } from './products.service';
import type { IProductRepository } from './domain/product.repository';
import { FilesService } from '../files/files.service';
import { FileObject } from '../files/domain/file-object.entity';
import { EntityNotFoundError } from '../shared/domain/domain-error';
import { Product } from './domain/product.entity';

// ── Minimal mocks ──────────────────────────────────────────────────────

function makeMockRepo(overrides: Partial<IProductRepository> = {}) {
  return {
    findById: jest.fn(),
    findBySku: jest.fn(),
    findByBarcode: jest.fn(),
    findAll: jest.fn(),
    save: jest.fn(),
    delete: jest.fn(),
    isSkuTaken: jest.fn<Promise<boolean>, any>().mockResolvedValue(false),
    isBarcodeTaken: jest.fn<Promise<boolean>, any>().mockResolvedValue(false),
    ...overrides,
  } as jest.Mocked<IProductRepository>;
}

function makeMockPrisma() {
  return {
    productImage: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    variant: {
      findFirst: jest.fn(),
    },
  } as any;
}

function makeMockFilesService() {
  return {
    uploadAndRegister: jest.fn(),
    delete: jest.fn(),
    findById: jest.fn(),
    findByIds: jest.fn(),
  } as any;
}

function createMockFile(
  originalname = 'test.jpg',
  mimetype = 'image/jpeg',
): Express.Multer.File {
  return {
    buffer: Buffer.from('fake-image-data'),
    originalname,
    mimetype,
    fieldname: 'file',
    encoding: '7bit',
    size: 1024,
    stream: null as any,
    destination: '',
    filename: '',
    path: '',
  };
}

describe('ProductsService — Product Image Upload', () => {
  let service: ProductsService;
  let repo: ReturnType<typeof makeMockRepo>;
  let prisma: ReturnType<typeof makeMockPrisma>;
  let filesService: ReturnType<typeof makeMockFilesService>;

  beforeEach(() => {
    repo = makeMockRepo();
    prisma = makeMockPrisma();
    filesService = makeMockFilesService();
    service = new ProductsService(repo, prisma, filesService);
  });

  describe('uploadProductImage (S15, S16)', () => {
    it('S15: should upload product image successfully', async () => {
      // Arrange
      const productId = 'prod-1';
      const uploadedBy = 'user-1';
      const file = createMockFile('product-image.jpg', 'image/jpeg');

      const mockProduct = Product.create({
        id: productId,
        name: 'Test Product',
      });
      repo.findById.mockResolvedValueOnce(mockProduct);

      const mockFileObject = FileObject.create({
        id: 'file-123',
        storageKey: 'Product/prod-1/uuid-abc.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        ownerType: 'Product',
        ownerId: productId,
        uploadedBy,
        createdAt: new Date(),
      });

      filesService.uploadAndRegister.mockResolvedValueOnce(mockFileObject);

      prisma.productImage.findFirst.mockResolvedValueOnce(null); // No existing images

      prisma.productImage.create.mockResolvedValueOnce({
        id: 'img-1',
        productId,
        fileId: 'file-123',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
        isMain: false,
        sortOrder: 0,
        variantId: null,
      });

      // Act
      const result = await service.uploadProductImage(
        productId,
        file,
        uploadedBy,
      );

      // Assert
      expect(result).toEqual({
        id: 'img-1',
        fileId: 'file-123',
        url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
        isMain: false,
        sortOrder: 0,
      });

      expect(filesService.uploadAndRegister).toHaveBeenCalledWith({
        buffer: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname,
        ownerType: 'Product',
        ownerId: productId,
        uploadedBy,
      });

      expect(prisma.productImage.create).toHaveBeenCalledWith({
        data: {
          productId,
          fileId: 'file-123',
          url: 'https://cdn.example.com/Product/prod-1/uuid-abc.jpg',
          isMain: false,
          sortOrder: 0,
        },
      });
    });

    it('S16: should handle multiple product image uploads with correct sortOrder', async () => {
      // Arrange
      const productId = 'prod-1';
      const uploadedBy = 'user-1';
      const file1 = createMockFile('image1.jpg', 'image/jpeg');
      const file2 = createMockFile('image2.jpg', 'image/jpeg');

      const mockProduct = Product.create({
        id: productId,
        name: 'Test Product',
      });
      repo.findById.mockResolvedValue(mockProduct);

      const mockFileObject1 = FileObject.create({
        id: 'file-1',
        storageKey: 'Product/prod-1/uuid-1.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-1.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        createdAt: new Date(),
      });

      const mockFileObject2 = FileObject.create({
        id: 'file-2',
        storageKey: 'Product/prod-1/uuid-2.jpg',
        url: 'https://cdn.example.com/Product/prod-1/uuid-2.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        createdAt: new Date(),
      });

      filesService.uploadAndRegister
        .mockResolvedValueOnce(mockFileObject1)
        .mockResolvedValueOnce(mockFileObject2);

      // First upload: no existing images
      prisma.productImage.findFirst.mockResolvedValueOnce(null);
      prisma.productImage.create.mockResolvedValueOnce({
        id: 'img-1',
        productId,
        fileId: 'file-1',
        url: mockFileObject1.url,
        isMain: false,
        sortOrder: 0,
        variantId: null,
      });

      // Second upload: one existing image with sortOrder 0
      prisma.productImage.findFirst.mockResolvedValueOnce({ sortOrder: 0 });
      prisma.productImage.create.mockResolvedValueOnce({
        id: 'img-2',
        productId,
        fileId: 'file-2',
        url: mockFileObject2.url,
        isMain: false,
        sortOrder: 1,
        variantId: null,
      });

      // Act
      const result1 = await service.uploadProductImage(
        productId,
        file1,
        uploadedBy,
      );
      const result2 = await service.uploadProductImage(
        productId,
        file2,
        uploadedBy,
      );

      // Assert
      expect(result1.sortOrder).toBe(0);
      expect(result2.sortOrder).toBe(1);
    });

    it('should throw EntityNotFoundError when product does not exist', async () => {
      // Arrange
      const productId = 'non-existent';
      const uploadedBy = 'user-1';
      const file = createMockFile();

      repo.findById.mockResolvedValueOnce(null);

      // Act & Assert
      await expect(
        service.uploadProductImage(productId, file, uploadedBy),
      ).rejects.toThrow(EntityNotFoundError);
    });
  });

  describe('uploadVariantImage (S18, S19)', () => {
    it('S18: should upload variant image successfully', async () => {
      // Arrange
      const productId = 'prod-1';
      const variantId = 'var-1';
      const uploadedBy = 'user-1';
      const file = createMockFile('variant-image.jpg', 'image/jpeg');

      const mockProduct = Product.create({
        id: productId,
        name: 'Test Product',
      });
      repo.findById.mockResolvedValueOnce(mockProduct);

      prisma.variant.findFirst.mockResolvedValueOnce({
        id: variantId,
        productId,
        name: 'Red',
      });

      const mockFileObject = FileObject.create({
        id: 'file-456',
        storageKey: 'ProductVariant/var-1/uuid-xyz.jpg',
        url: 'https://cdn.example.com/ProductVariant/var-1/uuid-xyz.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1024,
        ownerType: 'ProductVariant',
        ownerId: variantId,
        uploadedBy,
        createdAt: new Date(),
      });

      filesService.uploadAndRegister.mockResolvedValueOnce(mockFileObject);

      prisma.productImage.findFirst.mockResolvedValueOnce(null); // No existing images for this variant

      prisma.productImage.create.mockResolvedValueOnce({
        id: 'img-var-1',
        productId,
        variantId,
        fileId: 'file-456',
        url: 'https://cdn.example.com/ProductVariant/var-1/uuid-xyz.jpg',
        isMain: false,
        sortOrder: 0,
      });

      // Act
      const result = await service.uploadVariantImage(
        productId,
        variantId,
        file,
        uploadedBy,
      );

      // Assert
      expect(result).toEqual({
        id: 'img-var-1',
        fileId: 'file-456',
        url: 'https://cdn.example.com/ProductVariant/var-1/uuid-xyz.jpg',
        isMain: false,
        sortOrder: 0,
        variantId,
      });

      expect(filesService.uploadAndRegister).toHaveBeenCalledWith({
        buffer: file.buffer,
        mimeType: file.mimetype,
        originalName: file.originalname,
        ownerType: 'ProductVariant',
        ownerId: variantId,
        uploadedBy,
      });
    });

    it('S19: should throw EntityNotFoundError when variant does not belong to product', async () => {
      // Arrange
      const productId = 'prod-1';
      const variantId = 'var-999'; // Variant doesn't belong to this product
      const uploadedBy = 'user-1';
      const file = createMockFile();

      const mockProduct = Product.create({
        id: productId,
        name: 'Test Product',
      });
      repo.findById.mockResolvedValueOnce(mockProduct);

      prisma.variant.findFirst.mockResolvedValueOnce(null); // Variant not found for this product

      // Act & Assert
      await expect(
        service.uploadVariantImage(productId, variantId, file, uploadedBy),
      ).rejects.toThrow(EntityNotFoundError);
    });

    it('should throw EntityNotFoundError when product does not exist', async () => {
      // Arrange
      const productId = 'non-existent';
      const variantId = 'var-1';
      const uploadedBy = 'user-1';
      const file = createMockFile();

      repo.findById.mockResolvedValueOnce(null);

      // Act & Assert
      await expect(
        service.uploadVariantImage(productId, variantId, file, uploadedBy),
      ).rejects.toThrow(EntityNotFoundError);
    });
  });
});
