import { actorDisplayName } from './actor-display-name';

describe('actorDisplayName', () => {
  it('uses the trimmed name when there is one', () => {
    expect(actorDisplayName({ name: '  Ana López ', email: 'a@x.mx' })).toBe(
      'Ana López',
    );
  });

  it.each([
    ['empty', '', 'ana.lopez@example.com', 'ana.lopez'],
    ['blank', '   ', 'caja1@example.com', 'caja1'],
  ])(
    'falls back to the email local part for a %s name',
    (_c, name, email, expected) => {
      expect(actorDisplayName({ name, email })).toBe(expected);
    },
  );

  it.each([
    ['no usable email', '', ''],
    ['an email with an empty local part', ' ', '@example.com'],
    ['a blank email', ' ', '   '],
  ])('falls back to "Usuario" with %s', (_c, name, email) => {
    expect(actorDisplayName({ name, email })).toBe('Usuario');
  });

  it('never returns an empty string', () => {
    for (const name of ['', ' ', '\n\t']) {
      for (const email of ['', ' ', '@x', 'a@x']) {
        expect(actorDisplayName({ name, email }).length).toBeGreaterThan(0);
      }
    }
  });
});
