import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import type {
  AppAbility,
  AppActions,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { holdsCustomerExportPermission } from './customer-export.permission';

function ability(grants: Array<[AppActions, AppSubjects]>): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  for (const [action, subject] of grants) can(action, subject);
  return build();
}

describe('holdsCustomerExportPermission (owner L3: a special permission)', () => {
  it('explicit export:Customer → allowed', () => {
    expect(
      holdsCustomerExportPermission(
        ability([
          ['read', 'Customer'],
          ['export', 'Customer'],
        ]),
      ),
    ).toBe(true);
  });

  it('Super Admin manage:all → allowed', () => {
    expect(holdsCustomerExportPermission(ability([['manage', 'all']]))).toBe(
      true,
    );
  });

  it('manage:Customer does NOT imply the export (CASL wildcard is not enough, batch_delete precedent)', () => {
    const a = ability([['manage', 'Customer']]);
    // CASL itself would say yes...
    expect(a.can('export', 'Customer')).toBe(true);
    // ...the special permission needs the explicit row.
    expect(holdsCustomerExportPermission(a)).toBe(false);
  });

  it.each<[string, Array<[AppActions, AppSubjects]>]>([
    ['no grants', []],
    ['read:Customer only', [['read', 'Customer']]],
    [
      'read:Customer + read:Sale',
      [
        ['read', 'Customer'],
        ['read', 'Sale'],
      ],
    ],
    ['export on another subject', [['export', 'Sale']]],
  ])('%s → denied', (_label, grants) => {
    expect(holdsCustomerExportPermission(ability(grants))).toBe(false);
  });
});
