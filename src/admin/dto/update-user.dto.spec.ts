import { createAppValidationPipe } from '../../shared/listing/app-validation.pipe';
import { UpdateUserDto } from './update-user.dto';

const validate = (body: unknown) =>
  createAppValidationPipe().transform(body, {
    type: 'body',
    metatype: UpdateUserDto,
  });

describe('UpdateUserDto', () => {
  it('preserves name-only clients and normalizes email without coercion', async () => {
    await expect(validate({ name: 'Name' })).resolves.toEqual({ name: 'Name' });
    await expect(
      validate({ name: 'Name', email: ' NEW@Example.COM ' }),
    ).resolves.toEqual({ name: 'Name', email: 'new@example.com' });
  });

  it('accepts a nonempty unique UUID role set', async () => {
    const roleIds = ['11111111-1111-4111-8111-111111111111'];
    await expect(validate({ name: 'Name', roleIds })).resolves.toEqual({
      name: 'Name',
      roleIds,
    });
  });

  it.each([
    {},
    { name: null },
    { name: 1 },
    { name: '' },
    { name: 'Name', email: null },
    { name: 'Name', email: 12 },
    { name: 'Name', email: ['a@example.com'] },
    { name: 'Name', email: { toString: () => 'a@example.com' } },
    { name: 'Name', email: 'invalid' },
    { name: 'Name', roleIds: null },
    { name: 'Name', roleIds: [] },
    { name: 'Name', roleIds: '11111111-1111-4111-8111-111111111111' },
    { name: 'Name', roleIds: [12] },
    { name: 'Name', roleIds: ['invalid'] },
    {
      name: 'Name',
      roleIds: [
        '11111111-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111',
      ],
    },
    { name: 'Name', isSuperAdmin: true },
  ])('rejects malformed fields: %p', async (body) => {
    await expect(validate(body)).rejects.toMatchObject({ status: 400 });
  });
});
