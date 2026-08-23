import type { ImageEntry, OrganizeBinding } from '../../core/src/types';

export interface ParsedName {
  virtualPath: string;
  confidence: number;
  rule: string;
}

const FULLWIDTH_SEP = /[\uff0f\uff3c\u203a\u300b|]/;

// Chinese chars used by naming rules (kept as unicode escapes to avoid encoding issues):
// \u7b2c = di4 (ordinal), \u5377 = juan3 (volume), \u8bdd/\u8a71 = hua4 (chapter),
// \u96c6 = ji2 (collection), \u5e74 = nian2 (year), \u6708 = yue4 (month), \u65e5 = ri4 (day).
const CHAPTER_RE =
  /^(.+?)[ _-]*(?:\u7b2c\s*(\d{1,4})\s*[\u5377\u8a71\u8bdd\u96c6]|[Vv][Oo][Ll][.]?\s*(\d{1,4})|(?:ch(?:apter)?|ep)\s*(\d{1,4}))[ _-]*(?:p[._ -]*(\d{1,4}))?$/;
const DATE_RE = /^(\d{4})[-_.\u5e74](\d{1,2})(?:[-_.\u6708](\d{1,2}))?\u65e5?[_ -]*(.*)$/;

export function parseImageName(fileName: string): ParsedName {
  const base = fileName.replace(/\.[^.]+$/, '').trim();
  if (!base) return { virtualPath: `Unsorted/${fileName}`, confidence: 0, rule: 'empty' };

  // 1. Explicit hierarchy separators (fullwidth slash, backslash, raquo, etc.)
  if (FULLWIDTH_SEP.test(base)) {
    const parts = base.split(FULLWIDTH_SEP).map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      return { virtualPath: parts.join('/') + extSuffix(fileName), confidence: 0.95, rule: 'separator' };
    }
  }

  // 2. Date patterns: 2024-03-05_xxx / 2024_03_05 / 2024 nian 3 yue 5 ri
  const dm = base.match(DATE_RE);
  if (dm) {
    const year = dm[1]!;
    const month = dm[2]!.padStart(2, '0');
    const day = dm[3]?.padStart(2, '0');
    const rest = dm[4]?.trim();
    const path = day ? `${year}/${month}/${day}/${rest}` : `${year}/${month}/${rest}`;
    return { virtualPath: `${path.replace(/\/+$/, '')}${extSuffix(fileName)}`, confidence: 0.85, rule: 'date' };
  }

  // 3. Author tag: [author] title
  const am = base.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (am) {
    return { virtualPath: `${am[1]}/${am[2]}${extSuffix(fileName)}`, confidence: 0.8, rule: 'author' };
  }

  // 4. Volume/chapter/page: series Vol.01 p001 / series ch001 p12 / series EP4
  const cm = base.match(CHAPTER_RE);
  if (cm) {
    const series = cm[1]!.trim();
    const num = cm[2] ?? cm[3] ?? cm[4] ?? '01';
    const page = cm[5];
    const volumeDir = `${series}/Vol.${String(num).padStart(2, '0')}`;
    const path = page ? `${volumeDir}/p${String(page).padStart(3, '0')}` : `${volumeDir}/${base}`;
    return { virtualPath: `${path}${extSuffix(fileName)}`, confidence: page ? 0.9 : 0.8, rule: 'chapter' };
  }

  // 5. Generic series-number: Title 01
  const gm = base.match(/^(.+?)[ _-]+(\d{2,4})$/);
  if (gm) {
    return { virtualPath: `${gm[1].trim()}/${base}${extSuffix(fileName)}`, confidence: 0.6, rule: 'commonPrefix' };
  }

  // 6. Conservative fallback
  return { virtualPath: `Unsorted/${fileName}`, confidence: 0.2, rule: 'fallback' };
}

function extSuffix(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx < 0 ? '' : fileName.slice(idx);
}

export function organizeImages(images: ImageEntry[]): OrganizeBinding[] {
  return images.map((image) => {
    const parsed = parseImageName(image.name);
    return {
      imageId: image.id,
      virtualPath: parsed.virtualPath,
      confidence: parsed.confidence,
      materialized: false,
    };
  });
}

export function organizeByFolder(images: ImageEntry[]): OrganizeBinding[] {
  return organizeImages(images);
}
