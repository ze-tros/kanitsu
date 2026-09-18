import type { LibrarySnapshot } from './types';

/**
 * A synchronous mirror of the last adopted library snapshot, kept in localStorage
 * so the renderer can hydrate the UI on first paint instead of showing an empty
 * shell until the async PersistentIndex load resolves. The mirror is allowed to
 * be slightly stale: the `loadOrScan` result always overwrites it right after,
 * so it is only ever a paint hint, never the source of truth.
 */
const MIRROR_KEY = 'kanitsu-snapshot-mirror';

function getStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Storage can be blocked (security/privacy settings) — treat as unavailable.
    return null;
  }
}

function isValid(snapshot: LibrarySnapshot | null): snapshot is LibrarySnapshot {
  return !!snapshot
    && typeof snapshot.rootId === 'string'
    && !!snapshot.folders
    && !!snapshot.images;
}

/** Returns the mirrored snapshot from the last session, or `null` if none/unusable. */
export function readSnapshotMirror(): LibrarySnapshot | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(MIRROR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LibrarySnapshot | null;
    return isValid(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Mirrors the snapshot synchronously; silently skips on quota or storage errors. */
export function writeSnapshotMirror(snapshot: LibrarySnapshot): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(MIRROR_KEY, JSON.stringify(snapshot));
  } catch {
    // Quota exceeded (very large libraries) or storage unavailable — startup
    // hydration simply falls back to the async index load.
  }
}

export function clearSnapshotMirror(): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(MIRROR_KEY);
  } catch {
    // Ignore.
  }
}
