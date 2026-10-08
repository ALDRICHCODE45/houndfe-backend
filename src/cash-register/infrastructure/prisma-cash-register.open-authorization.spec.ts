import { AbilityBuilder, createMongoAbility } from '@casl/ability';
import { randomUUID } from 'crypto';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import {
  actor,
  asJson,
  makeApp,
  seedActors,
} from './prisma-cash-register.test-support';

async function setup() {
  const context = makeApp();
  seedActors(context.host, ['u1']);
  const register = asJson(
    await context.app.execute(
      actor('u1'),
      {
        kind: 'CREATE_REGISTER',
        name: 'Register A',
      },
      randomUUID(),
    ),
  );
  const command = {
    kind: 'OPEN_SESSION' as const,
    registerId: register.id as string,
    openingCents: 0,
    openingConfirmed: true,
  };
  return { ...context, command };
}

describe('OPEN_SESSION resource authorization', () => {
  it('authorizes the prospective owner and replays the persisted session after freeze', async () => {
    const { app, host, command } = await setup();
    const { can, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
    can('create', 'CashSession', {
      cashierUserId: 'u1',
      ownerUserId: 'u1',
      registerId: command.registerId,
    });
    const owner = { userId: 'u1', ability: build() };
    const key = randomUUID();
    const opened = await app.execute(owner, command, key);
    const sessionId = asJson(asJson(opened).session).id as string;
    expect(sessionId).not.toBe(command.registerId);
    await app.execute(
      actor('u1'),
      { kind: 'START_COUNT', sessionId },
      randomUUID(),
    );
    expect(await app.execute(owner, command, key)).toEqual(opened);
    expect(host.db.sessions).toHaveLength(1);
    const {
      can: allow,
      cannot,
      build: revoked,
    } = new AbilityBuilder<AppAbility>(createMongoAbility);
    allow('create', 'CashSession');
    cannot('create', 'CashSession', { id: sessionId });
    await expect(
      app.execute({ userId: 'u1', ability: revoked() }, command, key),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
    expect(host.db.sessions).toHaveLength(1);
  });

  it('enforces inverted owner conditions before creating any session or idempotency result', async () => {
    const { app, host, command } = await setup();
    const { can, cannot, build } = new AbilityBuilder<AppAbility>(
      createMongoAbility,
    );
    can('create', 'CashSession');
    cannot('create', 'CashSession', { cashierUserId: 'u1' });
    const before = host.db.commands.length;
    await expect(
      app.execute({ userId: 'u1', ability: build() }, command, randomUUID()),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
    expect(host.db.sessions).toHaveLength(0);
    expect(host.db.commands).toHaveLength(before);
  });
});
