import { describe, expect, it } from 'vitest';
import { Mutex } from '../../src/Domain/Mutex.js';

const wait = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Mutex', () => {
  it('serializes concurrent sections in call order', async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const first = mutex.run(async () => {
      await wait(10);
      order.push('first');
    });
    const second = mutex.run(async () => {
      order.push('second');
    });
    await Promise.all([first, second]);

    expect(order).toEqual(['first', 'second']);
  });

  it('releases the lock when a section throws', async () => {
    const mutex = new Mutex();

    await expect(
      mutex.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const order: string[] = [];
    await mutex.run(async () => {
      order.push('ran');
    });

    expect(order).toEqual(['ran']);
  });
});
