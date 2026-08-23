export interface ThumbnailResult {
  blob: Blob;
  width: number;
  height: number;
}

export interface ThumbnailOptions {
  maxSize?: number;
  quality?: number;
  type?: string;
}

/** Browser thumbnail generator; Electron may replace with sharp later. */
export async function generateThumbnail(
  source: Blob,
  options: ThumbnailOptions = {},
): Promise<ThumbnailResult> {
  const maxSize = options.maxSize ?? 512;
  const quality = options.quality ?? 0.78;
  const type = options.type ?? 'image/webp';

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(source);
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await canvas.convertToBlob({ type, quality });
    bitmap.close();
    return { blob, width, height };
  }

  return await legacyThumbnail(source, maxSize, type, quality);
}

function legacyThumbnail(source: Blob, maxSize: number, type: string, quality: number): Promise<ThumbnailResult> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSize / Math.max(img.naturalWidth, img.naturalHeight));
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => (blob ? resolve({ blob, width, height }) : reject(new Error('toBlob returned null'))),
        type,
        quality,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decode failed'));
    };
    img.src = url;
  });
}

export async function readImageDimensions(source: Blob): Promise<{ width: number; height: number }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(source);
    const dim = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dim;
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(source);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Image decode failed'));
    };
    img.src = url;
  });
}
