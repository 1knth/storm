import { useEffect, useState } from 'react';
import { vaultImageErrorMessage } from './vaultImageError';

interface VaultImageProps {
  vaultId: string;
  notePath: string;
  src: string;
  alt?: string;
  width?: number;
  kind?: 'markdown' | 'wiki';
}

export function VaultImage({
  vaultId,
  notePath,
  src,
  alt = '',
  width,
  kind = 'markdown',
}: VaultImageProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setImageUrl(null);
    setError(null);
    window.vault
      .readImage({ vaultId, notePath, imagePath: src, kind })
      .then((image) => {
        if (cancelled) return;
        if (!image.ok) {
          const messages = {
            'not-found': 'Image not found in this vault.',
            ambiguous: 'Multiple matching images found in this vault.',
            unsupported: 'This image format or content is not supported.',
            unavailable: 'Image could not be read from this vault.',
          };
          setError(messages[image.reason]);
          return;
        }
        const binary = atob(image.base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++)
          bytes[index] = binary.charCodeAt(index);
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: image.mimeType }),
        );
        setImageUrl(objectUrl);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(vaultImageErrorMessage(reason));
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [vaultId, notePath, src, kind]);

  if (error)
    return (
      <span role="img" aria-label={alt || error}>
        {error}
      </span>
    );
  if (!imageUrl) return <span role="status">Loading image…</span>;
  return (
    <img
      src={imageUrl}
      alt={alt}
      style={{
        display: 'block',
        maxWidth: '100%',
        height: 'auto',
        ...(width ? { width: Math.min(Math.max(width, 1), 4096) } : {}),
      }}
    />
  );
}
