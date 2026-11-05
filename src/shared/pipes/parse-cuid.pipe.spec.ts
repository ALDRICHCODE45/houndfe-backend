import { BadRequestException } from '@nestjs/common';
import { ParseCuidPipe } from './parse-cuid.pipe';

describe('ParseCuidPipe', () => {
  const pipe = new ParseCuidPipe();

  it.each([
    ['a Prisma cuid v1', 'cmw2izrjw0002r965eh02ytw3'],
    ['a cuid2', 'tz4a98xxat96iws9zmbrgj3a'],
  ])('passes %s through unchanged', (_label, value) => {
    expect(pipe.transform(value)).toBe(value);
  });

  it.each([
    ['an empty string', ''],
    ['a UUID', 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'],
    ['an over-long id', 'c'.repeat(33)],
    ['a too-short id', 'c'.repeat(19)],
    ['an id with a space', 'cmw2izrjw0002 r965eh02ytw3'],
    ['an id with a slash', 'cmw2izrjw0002/r965eh02ytw3'],
    ['an uppercase id', 'CMW2IZRJW0002R965EH02YTW3'],
  ])('rejects %s with the ParseUUIDPipe-shaped 400', (_label, value) => {
    expect(() => pipe.transform(value)).toThrow(
      new BadRequestException('Validation failed (cuid is expected)'),
    );
  });
});
