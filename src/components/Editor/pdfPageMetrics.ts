export type PageSize = { width: number; height: number };

/** Layout metrics for a virtual PDF page list. Sizes are cached at native scale. */
export class PdfPageMetrics {
  private nativeSizes = new Map<number, PageSize>();
  private offsets: number[] = [0];

  constructor(
    readonly pageCount: number,
    private readonly defaultSize: PageSize,
    private zoom: number,
    private readonly gap = 24,
  ) {
    this.rebuild();
  }

  setZoom(zoom: number) {
    if (this.zoom === zoom) return;
    this.zoom = zoom;
    this.rebuild();
  }

  setSize(page: number, size: PageSize) {
    if (page < 1 || page > this.pageCount) return;
    const old = this.nativeSizes.get(page);
    if (old?.width === size.width && old.height === size.height) return;
    this.nativeSizes.set(page, size);
    this.rebuild();
  }

  size(page: number): PageSize {
    const native = this.nativeSizes.get(page) ?? this.defaultSize;
    return {
      width: native.width * this.zoom,
      height: native.height * this.zoom,
    };
  }

  top(page: number): number {
    return this.offsets[Math.max(0, Math.min(this.pageCount, page - 1))];
  }

  totalHeight(): number {
    return this.offsets[this.pageCount] ?? 0;
  }

  pageAt(offset: number): number {
    let low = 0;
    let high = this.pageCount;
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (this.offsets[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return Math.max(1, Math.min(this.pageCount, low + 1));
  }

  window(scrollTop: number, viewportHeight: number, overscan = 2) {
    const firstVisible = this.pageAt(scrollTop);
    const lastVisible = this.pageAt(scrollTop + viewportHeight);
    return {
      first: Math.max(1, firstVisible - overscan),
      last: Math.min(this.pageCount, lastVisible + overscan),
    };
  }

  private rebuild() {
    this.offsets = Array.from({ length: this.pageCount + 1 }, () => 0);
    this.offsets[0] = 0;
    for (let page = 1; page <= this.pageCount; page++) {
      const size = this.nativeSizes.get(page) ?? this.defaultSize;
      this.offsets[page] =
        this.offsets[page - 1] +
        size.height * this.zoom +
        (page < this.pageCount ? this.gap : 0);
    }
  }
}
