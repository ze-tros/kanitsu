import assert from 'node:assert/strict';
import test from 'node:test';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';
import {
  clearThumbnailCache,
  getRendererThumbnailStats,
  getThumbnailBlob,
  peekThumbnailBlob,
  setThumbnailPreloadPaused,
  THUMB_PRIORITY_CURRENT_DIR,
  THUMB_PRIORITY_DIRECTIONAL,
  THUMB_PRIORITY_VISIBLE,
  THUMB_PRIORITY_WARMUP,
} from '../src/thumbnailCache';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function file(id: string): FileRef {
  return { id, name: `${id}.jpg`, kind: 'file', size: 1, mtime: 1 };
}

function storeWith(
  readThumbnail: LibraryStore['readThumbnail'],
): LibraryStore {
  return { readThumbnail } as LibraryStore;
}

function blobWithReportedSize(size: number, marker: string): Blob {
  const blob = new Blob([marker]);
  Object.defineProperty(blob, 'size', { value: size });
  return blob;
}

async function flushTasks(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('evicts after asynchronous Blob sizes are committed', async () => {
  clearThumbnailCache();
  const fourMiB = 4 * 1024 * 1024;
  const store = storeWith(async (source) => blobWithReportedSize(fourMiB, source.id));

  await Promise.all(
    Array.from({ length: 65 }, (_, index) =>
      getThumbnailBlob(store, file(`evict-${index}`), 512),
    ),
  );

  const stats = getRendererThumbnailStats();
  assert.equal(stats.entries, 64);
  assert.equal(stats.bytes, 256 * 1024 * 1024);
  assert.equal(peekThumbnailBlob(file('evict-0'), 512), null);
  assert.notEqual(peekThumbnailBlob(file('evict-64'), 512), null);
});

test('clear prevents an old in-flight request from repopulating the cache', async () => {
  clearThumbnailCache();
  const pending = deferred<Blob>();
  const source = file('stale-after-clear');
  const store = storeWith(() => pending.promise);
  const request = getThumbnailBlob(store, source, 512);

  clearThumbnailCache();
  const staleBlob = new Blob(['stale']);
  pending.resolve(staleBlob);

  assert.equal(await request, staleBlob);
  assert.equal(peekThumbnailBlob(source, 512), null);
  assert.equal(getRendererThumbnailStats().entries, 0);
  assert.equal(getRendererThumbnailStats().bytes, 0);
});

test('priority upgrades reuse one underlying read for every caller', async () => {
  clearThumbnailCache();
  const pending = deferred<Blob>();
  const source = file('priority-race');
  let started = 0;
  const store = storeWith(() => {
    started++;
    return pending.promise;
  });

  const originalRequest = getThumbnailBlob(store, source, 512, { priority: 4 });
  const upgradedRequest = getThumbnailBlob(store, source, 512, { priority: 0 });
  const canonicalBlob = new Blob(['visible']);

  await flushTasks();
  assert.equal(started, 1);
  pending.resolve(canonicalBlob);

  assert.equal(await upgradedRequest, canonicalBlob);
  assert.equal(await originalRequest, canonicalBlob);
  assert.equal(peekThumbnailBlob(source, 512), canonicalBlob);
});

test('directional recheck promotes the queued job without a duplicate read', async () => {
  clearThumbnailCache();
  setThumbnailPreloadPaused(false);
  const blockers = Array.from({ length: 3 }, () => deferred<Blob>());
  const pending = deferred<Blob>();
  const started: string[] = [];
  const store = storeWith((source) => {
    started.push(source.id);
    if (source.id === 'directional-recheck') return pending.promise;
    const index = Number(source.id.slice('recheck-block-'.length));
    return blockers[index]!.promise;
  });
  const active = blockers.map((_gate, index) =>
    getThumbnailBlob(store, file(`recheck-block-${index}`), 512, { priority: THUMB_PRIORITY_VISIBLE }),
  );
  await flushTasks();

  const original = getThumbnailBlob(store, file('directional-recheck'), 512, { priority: THUMB_PRIORITY_CURRENT_DIR });
  const directional = getThumbnailBlob(store, file('directional-recheck'), 512, {
    priority: THUMB_PRIORITY_DIRECTIONAL,
    recheck: true,
  });
  await flushTasks();
  assert.equal(started.includes('directional-recheck'), false);

  blockers[0]!.resolve(new Blob(['done-0']));
  await flushTasks();
  assert.equal(started.filter((id) => id === 'directional-recheck').length, 1);
  pending.resolve(new Blob(['directional']));
  blockers[1]!.resolve(new Blob(['done-1']));
  blockers[2]!.resolve(new Blob(['done-2']));
  assert.equal(await original, await directional);
  await Promise.all(active);
});

test('cancelling one shared consumer does not cancel the remaining consumer', async () => {
  clearThumbnailCache();
  const pending = deferred<Blob>();
  const source = file('shared-consumers');
  let cancelled = false;
  const store = storeWith(() => pending.promise);

  const first = getThumbnailBlob(store, source, 512, { shouldCancel: () => cancelled });
  const second = getThumbnailBlob(store, source, 512);
  cancelled = true;
  const firstOutcome = first.then(() => 'resolved', (error: unknown) => (error as Error).name);
  await flushTasks();
  pending.resolve(new Blob(['shared']));

  assert.equal(await firstOutcome, 'ThumbnailReadCancelledError');
  assert.equal(await (await second).text(), 'shared');
});

test('all cancelled queued consumers skip the underlying read', async () => {
  clearThumbnailCache();
  const blockers = Array.from({ length: 3 }, () => deferred<Blob>());
  const started: string[] = [];
  const store = storeWith((source) => {
    started.push(source.id);
    const index = Number(source.id.slice('cancel-all-block-'.length));
    return blockers[index]?.promise ?? Promise.resolve(new Blob([source.id]));
  });
  const active = blockers.map((_gate, index) => getThumbnailBlob(store, file(`cancel-all-block-${index}`), 512));
  await flushTasks();

  let firstCancelled = false;
  let secondCancelled = false;
  const first = getThumbnailBlob(store, file('cancel-all'), 512, { priority: THUMB_PRIORITY_DIRECTIONAL, shouldCancel: () => firstCancelled });
  const second = getThumbnailBlob(store, file('cancel-all'), 512, { priority: THUMB_PRIORITY_DIRECTIONAL, shouldCancel: () => secondCancelled });
  firstCancelled = true;
  secondCancelled = true;
  blockers[0]!.resolve(new Blob(['done-0']));

  await assert.rejects(first, { name: 'ThumbnailReadCancelledError' });
  await assert.rejects(second, { name: 'ThumbnailReadCancelledError' });
  assert.equal(started.includes('cancel-all'), false);
  blockers[1]!.resolve(new Blob(['done-1']));
  blockers[2]!.resolve(new Blob(['done-2']));
  await Promise.all(active);
});

test('a cancelled queued entry can be requested again', async () => {
  clearThumbnailCache();
  setThumbnailPreloadPaused(true);
  const source = file('cancelled-retry');
  let cancelled = true;
  let attempts = 0;
  const store = storeWith(async () => {
    attempts++;
    return new Blob(['retry']);
  });

  const stale = getThumbnailBlob(store, source, 512, {
    priority: THUMB_PRIORITY_CURRENT_DIR,
    shouldCancel: () => cancelled,
  });
  setThumbnailPreloadPaused(false);
  await assert.rejects(stale, { name: 'ThumbnailReadCancelledError' });

  cancelled = false;
  assert.equal(await (await getThumbnailBlob(store, source, 512)).text(), 'retry');
  assert.equal(attempts, 1);
});
test('a failed read is removed so the next request can retry', async () => {
  clearThumbnailCache();
  const source = file('retry-after-failure');
  let attempts = 0;
  const store = storeWith(async () => {
    attempts++;
    if (attempts === 1) throw new Error('first failure');
    return new Blob(['retry']);
  });

  await assert.rejects(getThumbnailBlob(store, source, 512), { message: 'first failure' });
  assert.equal(await (await getThumbnailBlob(store, source, 512)).text(), 'retry');
  assert.equal(attempts, 2);
});

test('higher-priority reads overtake queued warmup work', async () => {
  clearThumbnailCache();
  setThumbnailPreloadPaused(false);
  const gates = new Map<string, Deferred<Blob>>();
  const started: string[] = [];
  const store = storeWith((source) => {
    started.push(source.id);
    const gate = deferred<Blob>();
    gates.set(source.id, gate);
    return gate.promise;
  });

  const blockers = Array.from({ length: 3 }, (_, index) =>
    getThumbnailBlob(store, file(`block-${index}`), 512, { priority: THUMB_PRIORITY_VISIBLE }),
  );
  await flushTasks();
  assert.deepEqual(started, ['block-0', 'block-1', 'block-2']);

  const warmup = getThumbnailBlob(store, file('warmup'), 512, { priority: THUMB_PRIORITY_WARMUP });
  const directional = getThumbnailBlob(store, file('directional'), 512, {
    priority: THUMB_PRIORITY_DIRECTIONAL,
  });
  gates.get('block-0')!.resolve(new Blob(['block-0']));
  await flushTasks();

  assert.equal(started[3], 'directional');
  assert.equal(started.includes('warmup'), false);

  gates.get('directional')!.resolve(new Blob(['directional']));
  gates.get('block-1')!.resolve(new Blob(['block-1']));
  gates.get('block-2')!.resolve(new Blob(['block-2']));
  await flushTasks();
  assert.equal(started.includes('warmup'), true);
  gates.get('warmup')!.resolve(new Blob(['warmup']));
  await Promise.all([...blockers, directional, warmup]);
});

test('background work always leaves one renderer slot for a visible thumbnail', async () => {
  clearThumbnailCache();
  setThumbnailPreloadPaused(false);
  const gates = new Map<string, Deferred<Blob>>();
  const started: string[] = [];
  const store = storeWith((source) => {
    started.push(source.id);
    const gate = deferred<Blob>();
    gates.set(source.id, gate);
    return gate.promise;
  });

  const background = Array.from({ length: 3 }, (_, index) =>
    getThumbnailBlob(store, file(`reserved-background-${index}`), 512, {
      priority: THUMB_PRIORITY_WARMUP,
    }),
  );
  await flushTasks();
  assert.deepEqual(started, ['reserved-background-0', 'reserved-background-1']);

  const visible = getThumbnailBlob(store, file('reserved-visible'), 512, {
    priority: THUMB_PRIORITY_VISIBLE,
  });
  await flushTasks();
  assert.equal(started[2], 'reserved-visible');
  assert.equal(started.includes('reserved-background-2'), false);

  gates.get('reserved-visible')!.resolve(new Blob(['visible']));
  gates.get('reserved-background-0')!.resolve(new Blob(['background-0']));
  await flushTasks();
  assert.equal(started.includes('reserved-background-2'), true);
  gates.get('reserved-background-1')!.resolve(new Blob(['background-1']));
  gates.get('reserved-background-2')!.resolve(new Blob(['background-2']));
  await Promise.all([...background, visible]);
});

test('stale queued directional reads cancel before reaching the store', async () => {
  clearThumbnailCache();
  setThumbnailPreloadPaused(false);
  const blockers = Array.from({ length: 3 }, () => deferred<Blob>());
  const started: string[] = [];
  const store = storeWith((source) => {
    started.push(source.id);
    const blockerIndex = Number(source.id.slice('cancel-block-'.length));
    return blockers[blockerIndex]?.promise ?? Promise.resolve(new Blob([source.id]));
  });
  const active = blockers.map((_gate, index) =>
    getThumbnailBlob(store, file(`cancel-block-${index}`), 512),
  );
  await flushTasks();

  const token = { cancelled: false };
  const stale = getThumbnailBlob(store, file('stale-directional'), 512, {
    priority: THUMB_PRIORITY_DIRECTIONAL,
    shouldCancel: () => token.cancelled,
  });
  token.cancelled = true;
  blockers[0]!.resolve(new Blob(['done-0']));

  await assert.rejects(stale, { name: 'ThumbnailReadCancelledError' });
  assert.equal(started.includes('stale-directional'), false);
  blockers[1]!.resolve(new Blob(['done-1']));
  blockers[2]!.resolve(new Blob(['done-2']));
  await Promise.all(active);
});

test('scroll pause blocks background reads but keeps visible and directional work running', async () => {
  clearThumbnailCache();
  setThumbnailPreloadPaused(true);
  const started: string[] = [];
  const store = storeWith(async (source) => {
    started.push(source.id);
    return new Blob([source.id]);
  });

  try {
    const background = getThumbnailBlob(store, file('paused-background'), 512, {
      priority: THUMB_PRIORITY_CURRENT_DIR,
    });
    const directional = getThumbnailBlob(store, file('live-directional'), 512, {
      priority: THUMB_PRIORITY_DIRECTIONAL,
    });
    const visible = getThumbnailBlob(store, file('live-visible'), 512, {
      priority: THUMB_PRIORITY_VISIBLE,
    });
    await Promise.all([directional, visible]);

    assert.equal(started.includes('paused-background'), false);
    assert.equal(started.includes('live-directional'), true);
    assert.equal(started.includes('live-visible'), true);

    setThumbnailPreloadPaused(false);
    await background;
    assert.equal(started.includes('paused-background'), true);
  } finally {
    setThumbnailPreloadPaused(false);
  }
});
