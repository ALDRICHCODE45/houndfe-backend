/**
 * cash-register-closing / S10 — direct characterization of the extracted
 * register command module.
 *
 * Exercises `cash-adapter-registers` in isolation (no facade, no
 * `prisma-cash-register` import) against the parent-owned in-memory tenant
 * harness. Each case pins one extraction boundary: a tenant-scoped write with
 * fail-closed not-found / name-conflict paths.
 */
import type { CashCommand } from '../cash-application.port';
import { createRegister, updateRegister } from './cash-adapter-registers';
import { actor, makeTenantHarness } from './cash-adapter.test-support';

type UpdateRegisterCommand = Extract<CashCommand, { kind: 'UPDATE_REGISTER' }>;

function updateCommand(
  id: string,
  patch: { name?: string; isActive?: boolean } = {},
): UpdateRegisterCommand {
  return { kind: 'UPDATE_REGISTER', id, ...patch };
}

describe('cash-adapter-registers — direct module contract', () => {
  it('creates a register with a trimmed name inside the tenant', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();

    const doc = await createRegister(
      tx,
      host.tenantId,
      actor('u1'),
      '  Caja Norte  ',
    );

    expect(doc.name).toBe('Caja Norte');
    expect(doc.isActive).toBe(true);
    expect(typeof doc.id).toBe('string');
    expect(host.db.registers).toHaveLength(1);
    expect(host.db.registers[0].name).toBe('Caja Norte');
    expect(host.db.registers[0].tenantId).toBe(host.tenantId);
  });

  it('rejects a duplicate name without a partial write', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    await createRegister(tx, host.tenantId, actor('u1'), 'Caja Uno');

    await expect(
      createRegister(tx, host.tenantId, actor('u1'), 'Caja Uno'),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_NAME_CONFLICT' });
    expect(host.db.registers).toHaveLength(1);
  });

  it('denies creation without the create capability and writes nothing', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();

    await expect(
      createRegister(tx, host.tenantId, actor('u1', []), 'Caja X'),
    ).rejects.toMatchObject({ code: 'CASH_PERMISSION_DENIED' });
    expect(host.db.registers).toHaveLength(0);
  });

  it('updates the name and active flag of an existing register', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    const created = await createRegister(
      tx,
      host.tenantId,
      actor('u1'),
      'Caja A',
    );

    const doc = await updateRegister(
      tx,
      host.tenantId,
      actor('u1'),
      updateCommand(created.id as string, { name: 'Caja B', isActive: false }),
    );

    expect(doc.name).toBe('Caja B');
    expect(doc.isActive).toBe(false);
    expect(host.db.registers[0].name).toBe('Caja B');
    expect(host.db.registers[0].isActive).toBe(false);
  });

  it('fails closed on an unknown register id', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();

    await expect(
      updateRegister(
        tx,
        host.tenantId,
        actor('u1'),
        updateCommand('missing-register', { isActive: false }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_NOT_FOUND' });
    expect(host.db.registers).toHaveLength(0);
  });

  it("rejects renaming onto another register's name and leaves the row unchanged", async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();
    await createRegister(tx, host.tenantId, actor('u1'), 'Caja A');
    const second = await createRegister(
      tx,
      host.tenantId,
      actor('u1'),
      'Caja B',
    );

    await expect(
      updateRegister(
        tx,
        host.tenantId,
        actor('u1'),
        updateCommand(second.id as string, { name: 'Caja A' }),
      ),
    ).rejects.toMatchObject({ code: 'CASH_REGISTER_NAME_CONFLICT' });

    expect(host.db.registers).toHaveLength(2);
    expect(host.db.registers[1].name).toBe('Caja B');
  });
});
