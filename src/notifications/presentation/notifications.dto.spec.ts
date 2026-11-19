import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { NotificationPreferencesDto } from './notifications.dto';

function errorsFor(body: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(NotificationPreferencesDto, body)).map(
    (error) => error.property,
  );
}

describe('NotificationPreferencesDto', () => {
  it('accepts either flag alone', () => {
    expect(errorsFor({ emailEnabled: false })).toEqual([]);
    expect(errorsFor({ soundEnabled: true })).toEqual([]);
  });

  it('rejects null so PATCH answers 400 instead of failing in Prisma', () => {
    expect(errorsFor({ emailEnabled: null })).toEqual(['emailEnabled']);
    expect(errorsFor({ soundEnabled: null })).toEqual(['soundEnabled']);
  });
});
