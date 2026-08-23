/** djb2 string hash used for stable local ids. */
export function stableHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function folderIdFor(relPath: string): string {
  return `folder:${relPath || '__root__'}`;
}

export function imageIdFor(relPath: string): string {
  return `img:${stableHash(relPath)}`;
}
