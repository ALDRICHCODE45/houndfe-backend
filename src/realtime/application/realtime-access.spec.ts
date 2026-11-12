/**
 * AccessGate (unit 8, R5): one access check per user inside the cache window,
 * one in-flight query per user, and a failed lookup is never served again.
 */
import {
  AccessGate,
  type AccessPort,
  type AccessResult,
} from './realtime-access';

const ALLOW = { can: () => true };
const ok: AccessResult = { ok: true, ability: ALLOW };

function setup(ttl = 1000) {
  let now = 1_000_000;
  const calls: string[] = [];
  let next: () => Promise<AccessResult> = () => Promise.resolve(ok);
  const source: AccessPort = {
    check: (tenant, user) => {
      calls.push(`${tenant}:${user}`);
      return next();
    },
  };
  const gate = new AccessGate(source, () => now, ttl);
  return {
    gate,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
    answer: (fn: () => Promise<AccessResult>) => {
      next = fn;
    },
  };
}

describe('AccessGate', () => {
  it('shares one lookup inside the window and refreshes after it', async () => {
    const { gate, calls, advance } = setup(1000);
    await gate.check('t', 'u');
    await gate.check('t', 'u');
    expect(calls).toHaveLength(1);
    advance(1000);
    await gate.check('t', 'u');
    expect(calls).toHaveLength(2);
  });

  it('keys by tenant and user', async () => {
    const { gate, calls } = setup();
    await gate.check('t1', 'u');
    await gate.check('t2', 'u');
    await gate.check('t1', 'v');
    expect(calls).toEqual(['t1:u', 't2:u', 't1:v']);
  });

  it('with a zero window every delivery checks again', async () => {
    const { gate, calls } = setup(0);
    await gate.check('t', 'u');
    await gate.check('t', 'u');
    expect(calls).toHaveLength(2);
  });

  it('concurrent callers share one in-flight lookup', async () => {
    const { gate, calls, answer } = setup();
    let finish: (r: AccessResult) => void = () => undefined;
    answer(
      () =>
        new Promise<AccessResult>((resolve) => {
          finish = resolve;
        }),
    );
    const both = Promise.all([gate.check('t', 'u'), gate.check('t', 'u')]);
    finish(ok);
    await both;
    expect(calls).toHaveLength(1);
  });

  it('a revoked answer is shared too (so a burst closes once)', async () => {
    const { gate, calls, answer } = setup();
    answer(() => Promise.resolve({ ok: false, reason: 'USER_INACTIVE' }));
    expect(await gate.check('t', 'u')).toEqual({
      ok: false,
      reason: 'USER_INACTIVE',
    });
    await gate.check('t', 'u');
    expect(calls).toHaveLength(1);
  });

  it('never serves a failed lookup from the cache', async () => {
    const { gate, calls, answer } = setup();
    answer(() => Promise.reject(new Error('db down')));
    await expect(gate.check('t', 'u')).rejects.toThrow('db down');
    answer(() => Promise.resolve(ok));
    await expect(gate.check('t', 'u')).resolves.toEqual(ok);
    expect(calls).toHaveLength(2);
  });

  it('prime seeds a fresh allow from the guards', async () => {
    const { gate, calls } = setup();
    const ability = { can: () => false };
    gate.prime('t', 'u', ability);
    expect(await gate.check('t', 'u')).toEqual({ ok: true, ability });
    expect(calls).toHaveLength(0);
  });
});
