import { describe, expect, it } from 'vitest';
import { createLock } from '../src/lock.js';

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('createLock', () => {
  it('serializes concurrent sections in call order', async () => {
    const lock = createLock();
    const order: string[] = [];

    const first = lock.run(async () => {
      await wait(10);
      order.push('first');
    });
    const second = lock.run(async () => {
      order.push('second');
    });
    await Promise.all([first, second]);

    expect(order).toEqual(['first', 'second']);
  });

  it('releases the lock when a section throws', async () => {
    const lock = createLock();

    await expect(
      lock.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const order: string[] = [];
    await lock.run(async () => {
      order.push('ran');
    });

    expect(order).toEqual(['ran']);
  });
});
