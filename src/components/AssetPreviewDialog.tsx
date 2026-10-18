import { useEffect, useState } from 'react';
import { vaultImageErrorMessage } from './Editor/vaultImageError';

type AssetPreviewDialogProps = {
  vaultId: string;
  relativePath: string;
  filename: string;
};

export default function AssetPreviewPane({
  vaultId,
  relativePath,
  filename,
}: AssetPreviewDialogProps) {
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setImageUrl(null);
    setError(null);
    void window.vault
      .readAsset({ vaultId, relativePath })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setError(
            result.reason === 'not-found'
              ? 'Image not found in this vault.'
              : result.reason === 'ambiguous'
                ? 'Multiple matching images found in this vault.'
                : result.reason === 'unsupported'
                  ? 'Image is unreadable or uses an unsupported format.'
                  : 'The image’s vault is unavailable. Reopen the image from an available vault.',
          );
          return;
        }
        try {
          const binary = atob(result.base64);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++)
            bytes[index] = binary.charCodeAt(index);
          objectUrl = URL.createObjectURL(
            new Blob([bytes], { type: result.mimeType }),
          );
          setImageUrl(objectUrl);
        } catch (readError) {
          setError(vaultImageErrorMessage(readError));
        }
      })
      .catch((readError: unknown) => {
        if (!cancelled) setError(vaultImageErrorMessage(readError));
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [vaultId, relativePath]);

  return (
    <div
      data-image-viewer="true"
      tabIndex={-1}
      aria-label={filename}
      className="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-4"
    >
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={filename}
          className="max-h-full max-w-full object-contain"
        />
      ) : error ? (
        <p role="alert" className="text-sm text-white/75">
          {error}
        </p>
      ) : (
        <p role="status" className="text-sm text-white/60">
          Loading image…
        </p>
      )}
    </div>
  );
}
