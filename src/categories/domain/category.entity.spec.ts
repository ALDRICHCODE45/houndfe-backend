import { Category } from './category.entity';
import { InvalidArgumentError } from '../../shared/domain/domain-error';

describe('Category Entity', () => {
  it('should create a category', () => {
    const cat = Category.create('id-1', 'Bebidas');
    expect(cat.id).toBe('id-1');
    expect(cat.name).toBe('Bebidas');
  });

  it('should trim whitespace', () => {
    const cat = Category.create('id-1', '  Bebidas  ');
    expect(cat.name).toBe('Bebidas');
  });

  it('should throw on empty name', () => {
    expect(() => Category.create('id-1', '')).toThrow(InvalidArgumentError);
    expect(() => Category.create('id-1', '   ')).toThrow(InvalidArgumentError);
  });

  it('should throw on name exceeding 50 chars', () => {
    const longName = 'A'.repeat(51);
    expect(() => Category.create('id-1', longName)).toThrow(
      InvalidArgumentError,
    );
  });

  it('should update name', () => {
    const cat = Category.create('id-1', 'Bebidas');
    cat.updateName('Alimentos');
    expect(cat.name).toBe('Alimentos');
  });

  it('should serialize to response', () => {
    const cat = Category.create('id-1', 'Bebidas');
    const response = cat.toResponse();
    expect(response.id).toBe('id-1');
    expect(response.name).toBe('Bebidas');
    expect(typeof response.createdAt).toBe('string');
  });
});
