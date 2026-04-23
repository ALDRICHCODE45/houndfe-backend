import { validate } from 'class-validator';
import { UploadFileDto } from './upload-file.dto';

describe('UploadFileDto', () => {
  it('should pass validation for valid DTO with all optional fields', async () => {
    // Arrange
    const dto = new UploadFileDto();
    dto.ownerType = 'Product';
    dto.ownerId = 'product-123';

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors).toHaveLength(0);
  });

  it('should pass validation when optional fields are omitted', async () => {
    // Arrange
    const dto = new UploadFileDto();

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors).toHaveLength(0);
  });

  it('should fail validation when ownerType is not a string', async () => {
    // Arrange
    const dto = new UploadFileDto();
    (dto as any).ownerType = 123;

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('ownerType');
  });
});
