import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SearchPosCatalogDto } from './search-pos-catalog.dto';

describe('SearchPosCatalogDto', () => {
  it('should pass validation with default values when all fields omitted', async () => {
    // Arrange
    const plain = {};
    const dto = plainToInstance(SearchPosCatalogDto, plain);

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(25);
    expect(dto.offset).toBe(0);
  });

  it('should pass validation with valid query string', async () => {
    // Arrange
    const plain = { q: 'Aspirina' };
    const dto = plainToInstance(SearchPosCatalogDto, plain);

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors).toHaveLength(0);
    expect(dto.q).toBe('Aspirina');
  });

  it('should pass validation with limit=50 (max)', async () => {
    // Arrange
    const plain = { limit: '50' };
    const dto = plainToInstance(SearchPosCatalogDto, plain);

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(50);
  });

  it('should fail validation when limit exceeds 50', async () => {
    // Arrange
    const plain = { limit: '51' };
    const dto = plainToInstance(SearchPosCatalogDto, plain);

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
  });

  it('should fail validation when limit is less than 1', async () => {
    // Arrange
    const plain = { limit: '0' };
    const dto = plainToInstance(SearchPosCatalogDto, plain);

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
  });

  it('should fail validation when offset is negative', async () => {
    // Arrange
    const plain = { offset: '-1' };
    const dto = plainToInstance(SearchPosCatalogDto, plain);

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('offset');
  });

  it('should coerce string limit to number', async () => {
    // Arrange
    const plain = { limit: '25' };
    const dto = plainToInstance(SearchPosCatalogDto, plain);

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(25);
    expect(typeof dto.limit).toBe('number');
  });

  it('should pass validation with valid categoryId UUID', async () => {
    // Arrange
    const plain = { categoryId: '550e8400-e29b-41d4-a716-446655440000' };
    const dto = plainToInstance(SearchPosCatalogDto, plain);

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors).toHaveLength(0);
    expect(dto.categoryId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should fail validation when categoryId is not a UUID', async () => {
    // Arrange
    const plain = { categoryId: 'not-a-uuid' };
    const dto = plainToInstance(SearchPosCatalogDto, plain);

    // Act
    const errors = await validate(dto);

    // Assert
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('categoryId');
  });
});
