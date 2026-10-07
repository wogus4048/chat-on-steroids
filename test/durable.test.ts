import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  flushDurable,
  initDurableStore,
  readDurable,
  resetDurableForTests,
  writeDurableNow,
  writeDurableSoon,
  writeDurableSnapshotSoon
} from '../src/main/durable.js';

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  resetDurableForTests();
  for (const dir of cleanup.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tempStore(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'clf-durable-'));
  cleanup.push(dir);
  initDurableStore(dir);
  return dir;
}

describe('durable state commit boundary', () => {
  it('starts independent pending files during flush without duplicating an active immediate write', async () => {
    await tempStore();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realRename = fs.rename.bind(fs);
    const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realRename(...args);
    });
    const first = writeDurableNow('first', { version: 1 });
    await blocked;
    writeDurableSoon('independent', { ready: true });
    const flushing = flushDurable();
    try {
      await vi.waitFor(async () => expect(await readDurable('independent')).toEqual({ ready: true }));
    } finally { release(); }
    await Promise.all([first, flushing]);
    expect(rename).toHaveBeenCalledTimes(2);
  });

  it('lets an independent file commit while preserving the blocked file FIFO', async () => {
    await tempStore();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return realRename(...args);
    });
    const first = writeDurableNow('first', { version: 1 });
    await blocked;
    const second = writeDurableNow('first', { version: 2 });
    try {
      await writeDurableNow('independent', { ready: true });
      await expect(readDurable('independent')).resolves.toEqual({ ready: true });
      await expect(readDurable('first')).resolves.toBeNull();
    } finally { release(); }
    await Promise.all([first, second]);
    await expect(readDurable('first')).resolves.toEqual({ version: 2 });
  });

  it('coalesces lazy allocations and retains a captured snapshot after a failed write', async () => {
    await tempStore();
    let version = 1;
    const snapshot = vi.fn(() => ({ version }));
    for (let i = 0; i < 50; i++) writeDurableSnapshotSoon('projection', snapshot);
    expect(snapshot).not.toHaveBeenCalled();
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('busy'));
    await expect(flushDurable()).rejects.toThrow('busy');
    expect(snapshot).toHaveBeenCalledTimes(1);
    version = 2;
    rename.mockRestore();
    await flushDurable();
    expect(snapshot).toHaveBeenCalledTimes(1);
    await expect(readDurable('projection')).resolves.toEqual({ version: 1 });
  });

  it('never substitutes a later lazy projection for an immediate commit generation', async () => {
    await tempStore();
    const writes: unknown[] = [];
    const realWrite = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      writes.push(JSON.parse(String(args[1])));
      return realWrite(...args);
    });
    const immediate = writeDurableNow('projection', { version: 1 });
    writeDurableSnapshotSoon('projection', () => ({ version: 2 }));
    await immediate;
    await flushDurable();
    expect(writes).toEqual([{ version: 1 }, { version: 2 }]);
  });

  it('rejects a failed immediate atomic rename and preserves the snapshot for retry', async () => {
    await tempStore();
    const busy = Object.assign(new Error('injected rename contention'), { code: 'EBUSY' });
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(busy);

    await expect(writeDurableNow('probe', { generation: 1 })).rejects.toMatchObject({ code: 'EBUSY' });
    expect(rename).toHaveBeenCalledTimes(1);

    rename.mockRestore();
    await flushDurable();
    await expect(readDurable('probe')).resolves.toEqual({ generation: 1 });
  });

  it('never lets an older in-flight generation erase a newer pending value', async () => {
    await tempStore();
    let releaseRename!: () => void;
    const renameEntered = new Promise<void>((resolve) => {
      vi.spyOn(fs, 'rename').mockImplementationOnce(async (...args) => {
        resolve();
        await new Promise<void>((release) => {
          releaseRename = release;
        });
        return vi.importActual<typeof import('node:fs/promises')>('node:fs/promises').then((real) =>
          real.rename(args[0] as string, args[1] as string)
        );
      });
    });

    const first = writeDurableNow('probe', { generation: 1 });
    await renameEntered;
    writeDurableSoon('probe', { generation: 2 });
    releaseRename();
    await first;
    await flushDurable();

    await expect(readDurable('probe')).resolves.toEqual({ generation: 2 });
  });

  it('flushes pending state even when its debounce timer is no longer the authority', async () => {
    await tempStore();
    writeDurableSoon('probe', { generation: 3 });
    await flushDurable();
    await expect(readDurable('probe')).resolves.toEqual({ generation: 3 });
  });

  it('attempts every pending state file even when one shutdown flush fails', async () => {
    await tempStore();
    const failed = Object.assign(new Error('injected swarm rename failure'), { code: 'EBUSY' });
    const realRename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${path.sep}swarm.json`)) throw failed;
      return realRename(from, to);
    });

    // Keep the failing entry first: the regression is that flushDurable used to throw here
    // and never even try the unrelated continuation snapshot queued behind it.
    writeDurableSoon('swarm', { run: 1 });
    writeDurableSoon('continuations', { token: 'safe' });

    await expect(flushDurable()).rejects.toMatchObject({ code: 'EBUSY' });
    await expect(readDurable('continuations')).resolves.toEqual({ token: 'safe' });
  });
});

it('invalidates a failed speculative generation before concurrent flush can retry it', async () => {
  await tempStore();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const rename = vi.spyOn(fs, 'rename').mockImplementationOnce(async () => {
    entered(); await gate; throw new Error('speculative failure');
  });
  const proposal = writeDurableNow('proposal', { accepted: true }, { retry: false });
  const observed = proposal.catch(error => error);
  await started;
  const concurrent = flushDurable().catch(error => error);
  release();
  expect(await observed).toMatchObject({ message: 'speculative failure' });
  await concurrent;
  await flushDurable();
  expect(rename).toHaveBeenCalledTimes(1);
  expect(await readDurable('proposal')).toBeNull();
  writeDurableSoon('proposal', { accepted: false });
  await flushDurable();
  expect(await readDurable('proposal')).toEqual({ accepted: false });
});

it('strict reads distinguish missing state from corrupt or unreadable authority without replacing it', async () => {
  const dir = await tempStore();
  expect(await readDurable('swarm', { strict: true })).toBeNull();
  await fs.mkdir(path.join(dir, 'state'), { recursive: true });
  await fs.writeFile(path.join(dir, 'state/swarm.json'), '{broken');
  await expect(readDurable('swarm', { strict: true })).rejects.toThrow();
  expect(await readDurable('swarm')).toBeNull();
  expect(await fs.readFile(path.join(dir, 'state/swarm.json'), 'utf8')).toBe('{broken');
  vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' }));
  await expect(readDurable('swarm', { strict: true })).rejects.toThrow('denied');
});
