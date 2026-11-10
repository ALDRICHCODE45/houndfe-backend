import { EventEmitter } from 'node:events';
import type { PgNotificationListener } from '../../shared/realtime/pg-notification-listener';
import { PgFeedWakeup } from './feed-wakeup';

/** The slice of the listener the wake-up uses, driven by hand. */
function fakeListener() {
  const bus = new EventEmitter();
  const listener = {
    start: () => Promise.resolve(),
    subscribe: (_channel: string, handler: (payload: string) => void) => {
      bus.on('notify', handler);
      return () => bus.off('notify', handler);
    },
    onConnected: (handler: () => void) => {
      bus.on('connected', handler);
      return () => bus.off('connected', handler);
    },
  };
  return {
    listener: listener as unknown as PgNotificationListener,
    notify: (tenantId: string) => bus.emit('notify', tenantId),
    connected: () => bus.emit('connected'),
  };
}

const settled = async (promise: Promise<void>) => {
  let done = false;
  void promise.then(() => (done = true));
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

describe('PgFeedWakeup', () => {
  it('wakes only the waiters of the notified tenant', async () => {
    const { listener, notify } = fakeListener();
    const wakeup = new PgFeedWakeup(listener);
    const mine = await wakeup.arm('t-1');
    const other = await wakeup.arm('t-2');
    const waitMine = mine.wait(10_000);
    const waitOther = other.wait(10_000);
    notify('t-1');
    expect(await settled(waitMine)).toBe(true);
    expect(await settled(waitOther)).toBe(false);
    mine.dispose();
    other.dispose();
  });

  it('does not lose a notification that lands between arm and wait', async () => {
    const { listener, notify } = fakeListener();
    const wakeup = new PgFeedWakeup(listener);
    const waiter = await wakeup.arm('t-1');
    notify('t-1');
    expect(await settled(waiter.wait(10_000))).toBe(true);
    waiter.dispose();
  });

  it('wakes every waiter when the LISTEN connection (re)connects', async () => {
    const { listener, connected } = fakeListener();
    const wakeup = new PgFeedWakeup(listener);
    const a = await wakeup.arm('t-1');
    const b = await wakeup.arm('t-2');
    const waits = [a.wait(10_000), b.wait(10_000)];
    connected();
    expect(await settled(waits[0])).toBe(true);
    expect(await settled(waits[1])).toBe(true);
  });

  describe('shutdown', () => {
    it('wakes the waiting long-polls at once and reports closing', async () => {
      const { listener } = fakeListener();
      const wakeup = new PgFeedWakeup(listener);
      const waiter = await wakeup.arm('t-1');
      const waiting = waiter.wait(25_000);
      expect(wakeup.closing).toBe(false);
      wakeup.onModuleDestroy();
      expect(wakeup.closing).toBe(true);
      expect(await settled(waiting)).toBe(true);
    });

    it('hands out waiters that do not wait once closed', async () => {
      const { listener } = fakeListener();
      const wakeup = new PgFeedWakeup(listener);
      wakeup.onModuleDestroy();
      const waiter = await wakeup.arm('t-1');
      expect(await settled(waiter.wait(25_000))).toBe(true);
    });

    it('stops listening to notifications', async () => {
      const { listener, notify } = fakeListener();
      const wakeup = new PgFeedWakeup(listener);
      wakeup.onModuleDestroy();
      const seen: string[] = [];
      const waiter = await wakeup.arm('t-1');
      void waiter.wait(50).then(() => seen.push('woke'));
      notify('t-1');
      expect(seen).toEqual([]);
    });
  });
});
