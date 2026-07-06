/**
 * Slice C — SearchSatKeyDto tests.
 *
 * Covers spec scenarios in tasks C.1.1 / C.1.2:
 *   - Global `ValidationPipe` (`main.ts:22-27`) has `transform:true` but NO
 *     `enableImplicitConversion`. So `limit`/`offset` query params arrive as
 *     strings. EXPLICIT `@Type(() => Number)` coerces them BEFORE `@IsInt`
 *     runs — W2 anchor.
 *   - Without explicit type coercion `@IsInt()` fails on the string `"200"`
 *     (rejects); with `@Type(() => Number)` + `@Max(50)` the DTO rejects
 *     `?limit=200` (capped at 50).
 *   - `?offset=-1` rejected by `@Min(0)`.
 *   - Missing `limit` defaults to 20; missing `offset` defaults to 0.
 *   - `search` is optional `@IsString`.
 *
 * Mirrors the established `src/sales/dto/search-pos-catalog.dto.spec.ts`
 * pattern: `plainToInstance` + `validate`.
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SearchSatKeyDto } from './search-sat-key.dto';

describe('SearchSatKeyDto — Slice C.1.1/1.2', () => {
  it('should apply defaults when all fields omitted (limit → 20, offset → 0)', async () => {
    const dto = plainToInstance(SearchSatKeyDto, {});

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(20);
    expect(dto.offset).toBe(0);
    expect(dto.search).toBeUndefined();
  });

  it('should coerce string `limit="20"` to number 20 (W2: @Type(() => Number))', async () => {
    const dto = plainToInstance(SearchSatKeyDto, { limit: '20' });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(20);
    expect(typeof dto.limit).toBe('number');
  });

  it('should accept limit at the cap (50)', async () => {
    const dto = plainToInstance(SearchSatKeyDto, { limit: '50' });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.limit).toBe(50);
  });

  it('should REJECT `?limit=200` (W2 anchor: above @Max(50))', async () => {
    const dto = plainToInstance(SearchSatKeyDto, { limit: '200' });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
  });

  it('should REJECT `?limit=0` (below @Min(1))', async () => {
    const dto = plainToInstance(SearchSatKeyDto, { limit: '0' });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('limit');
  });

  it('should REJECT `?offset=-1` (below @Min(0))', async () => {
    const dto = plainToInstance(SearchSatKeyDto, { offset: '-1' });

    const errors = await validate(dto);

    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe('offset');
  });

  it('should accept `?search=01010101` (optional string)', async () => {
    const dto = plainToInstance(SearchSatKeyDto, { search: '01010101' });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.search).toBe('01010101');
  });

  it('should accept `?search=aspirina&limit=10&offset=20` (full set)', async () => {
    const dto = plainToInstance(SearchSatKeyDto, {
      search: 'aspirina',
      limit: '10',
      offset: '20',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
    expect(dto.search).toBe('aspirina');
    expect(dto.limit).toBe(10);
    expect(dto.offset).toBe(20);
  });
});
