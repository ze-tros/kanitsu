import { useEffect, useState } from 'react';
import type { FileRef, LibraryStore } from '../../fs-adapter/src/types';

export function BlobImage({
  store,
  fileRef,
  alt,
  className,
  thumbnail = false,
}: {
  store: LibraryStore;
  fileRef: FileRef;
  alt?: string;
  className?: string;
  thumbnail?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    (thumbnail ? store.readThumbnail(fileRef, 512) : store.readBlob(fileRef))
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [store, fileRef.id]);

  if (failed) return <div className={`blob-image failed ${className ?? ''}`}>Cannot read</div>;
  if (!url) return <div className={`blob-image loading ${className ?? ''}`}>...</div>;
  return <img src={url} alt={alt ?? fileRef.name} className={className} />;
}
