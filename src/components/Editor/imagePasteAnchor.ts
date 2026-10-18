import type { ChangeDesc } from '@codemirror/state';

export type ImagePasteAnchor = {
  from: number;
  to: number;
  replaceSelection: boolean;
};

export function mapImagePasteAnchor(
  anchor: ImagePasteAnchor,
  changes: ChangeDesc,
): void {
  if (anchor.replaceSelection && anchor.from !== anchor.to) {
    changes.iterChangedRanges((fromA, toA) => {
      if (fromA < anchor.to && toA > anchor.from)
        anchor.replaceSelection = false;
    });
  }
  anchor.from = changes.mapPos(anchor.from, 1);
  anchor.to = changes.mapPos(anchor.to, -1);
  if (anchor.to < anchor.from) anchor.to = anchor.from;
}

export function imagePasteChange(anchor: ImagePasteAnchor, insert: string) {
  return {
    from: anchor.from,
    to: anchor.replaceSelection ? anchor.to : anchor.from,
    insert,
  };
}
