import { useEffect, useState } from 'react';
import { readExif, type ExifField, type ExifResult, type ExifRow } from '../../core/src/index';
import type { ImageEntry } from '../../core/src/types';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';

/** 一张图的 EXIF 读取状态：idle = 未请求（面板未开/无图），loading = 读取中。 */
export interface ExifState {
  status: 'idle' | 'loading' | 'ready';
  /** 面板优先展示的拍摄参数行；ready 且为空表示该图不含 EXIF。 */
  rows: ExifRow[];
  /** 全部已识别标签（检查器“全部 EXIF 标签”用）。 */
  fields: ExifField[];
}

const EMPTY_STATE: ExifState = { status: 'idle', rows: [], fields: [] };

/** 解析结果缓存：检查器与查看器对同一张图各开一次面板，不该读两遍文件。 */
const CACHE_LIMIT = 32;
const cache = new Map<string, ExifResult | null>();
const inflight = new Map<string, Promise<ExifResult | null>>();

function cacheKey(image: ImageEntry): string {
  return `${image.id}|${image.mtime}|${image.size}`;
}

function toFileRef(image: ImageEntry): FileRef {
  return {
    id: image.fileRefId ?? image.id,
    name: image.name,
    kind: 'file',
    mtime: image.mtime,
    size: image.size,
    width: image.width,
    height: image.height,
  };
}

/** 读取并解析一张图的 EXIF（按文件身份缓存，读不到就当没有，不抛错）。 */
export function loadExif(store: LibraryStore, image: ImageEntry): Promise<ExifResult | null> {
  const key = cacheKey(image);
  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const fileRef = toFileRef(image);
  const run = readExif({
    size: image.size,
    read: (offset, length) => store.readSlice(fileRef, offset, length),
  })
    .catch(() => null)
    .then((result) => {
      inflight.delete(key);
      cache.delete(key);
      cache.set(key, result);
      while (cache.size > CACHE_LIMIT) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
      return result;
    });
  inflight.set(key, run);
  return run;
}

/**
 * 取当前图的 EXIF。`enabled` 关着（面板未展开）时不发起读取；
 * 换图或重新展开时才读，结果进上面的缓存。
 */
export function useExifInfo(store: LibraryStore, image: ImageEntry | null, enabled = true): ExifState {
  const [state, setState] = useState<ExifState>(EMPTY_STATE);
  const imageId = image?.id;
  const mtime = image?.mtime;
  const size = image?.size;
  useEffect(() => {
    if (!image || !enabled) {
      setState((prev) => (prev.status === 'idle' ? prev : EMPTY_STATE));
      return;
    }
    const cached = cache.get(cacheKey(image));
    if (cached !== undefined) {
      setState({ status: 'ready', rows: cached?.rows ?? [], fields: cached?.fields ?? [] });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', rows: [], fields: [] });
    loadExif(store, image).then((result) => {
      if (cancelled) return;
      setState({ status: 'ready', rows: result?.rows ?? [], fields: result?.fields ?? [] });
    });
    return () => {
      cancelled = true;
    };
  }, [store, image, imageId, mtime, size, enabled]);
  return state;
}

/**
 * EXIF 拍摄参数行。行结构 `<div><span /><strong /></div>` 与
 * `.desktop-data-list` / `.viewer-info` 的数据行一致，可直接当子节点用。
 */
export function ExifRows({ state }: { state: ExifState }): JSX.Element | null {
  if (state.status === 'idle') return null;
  if (state.status === 'loading') {
    return (
      <div>
        <span />
        <strong>读取中…</strong>
      </div>
    );
  }
  if (state.rows.length === 0) {
    return (
      <div>
        <span />
        <strong>无 EXIF 信息</strong>
      </div>
    );
  }
  return (
    <>
      {state.rows.map((row) => (
        <div key={row.label}>
          <span>{row.label}</span>
          <strong title={row.value}>{row.value}</strong>
        </div>
      ))}
    </>
  );
}

/** 全部 EXIF 标签（检查器展开查看用）。 */
export function ExifFieldList({ fields }: { fields: ExifField[] }): JSX.Element {
  return (
    <>
      {fields.map((field) => (
        <div key={`${field.ifd}-${field.tag}`}>
          <span>{field.label}</span>
          <strong title={field.text}>{field.text}</strong>
        </div>
      ))}
    </>
  );
}
