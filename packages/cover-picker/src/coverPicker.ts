import type { ImageEntry } from '../../core/src/types';

export interface CoverScore {
  imageId: string;
  score: number;
  reason: string;
}

export interface CoverOptions {
  now?: number;
}

const NAME_PRIORITY = [
  { pattern: /(^|[_-])(cover|folder|front|preview|thumbnail)([_-]|\.)/i, weight: 1.0 },
  { pattern: /(^|[_-])00[01]([_-]|\.)/i, weight: 0.85 },
  { pattern: /(^|[_-])001([_-]|\.)/i, weight: 0.7 },
];

function aspectScore(width: number | undefined, height: number | undefined): number {
  if (!width || !height) return 0.5;
  const ratio = width / height;
  const ideal = [3 / 4, 1, 4 / 3, 2 / 3, 3 / 2];
  const best = Math.min(...ideal.map((r) => Math.abs(ratio - r)));
  return Math.max(0, 1 - best);
}

function namingScore(name: string): number {
  for (const p of NAME_PRIORITY) {
    if (p.pattern.test(name)) return p.weight;
  }
  return 0.2;
}

function recencyScore(mtime: number, now: number, maxAgeMs: number): number {
  if (!mtime) return 0.4;
  const age = Math.max(0, now - mtime);
  return Math.max(0, 1 - age / maxAgeMs);
}

function qualityScore(image: ImageEntry): number {
  let score = 0;
  if (image.width && image.height) {
    const short = Math.min(image.width, image.height);
    if (short >= 720) score += 0.5;
    else if (short >= 300) score += 0.35;
    else score += 0.15;
    score += aspectScore(image.width, image.height) * 0.3;
  } else {
    score += 0.3;
  }
  if (image.size > 200_000) score += 0.2;
  else if (image.size > 50_000) score += 0.1;
  return Math.min(1, score);
}

/** Picks a smart cover for a folder. With <10k images a full scan is fine. */
export function pickCover(images: ImageEntry[], options: CoverOptions = {}): CoverScore | null {
  if (images.length === 0) return null;
  const now = options.now ?? Date.now();
  const maxAgeMs = 365 * 24 * 60 * 60 * 1000;
  let best: CoverScore | null = null;

  for (const image of images) {
    const score =
      0.45 * namingScore(image.name) +
      0.25 * qualityScore(image) +
      0.15 * recencyScore(image.mtime, now, maxAgeMs) +
      0.15 * aspectScore(image.width, image.height);

    if (!best || score > best.score) {
      best = { imageId: image.id, score, reason: `name=${image.name}` };
    }
  }
  return best;
}
