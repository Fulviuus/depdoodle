export interface Bounds { left: number; top: number; right: number; bottom: number }
/** Grid index for sparse label collision queries. Huge rectangles use a
 * separate list so unusually long routes cannot allocate millions of cells. */
export class RectangleIndex<T extends { rect: Bounds }> {
  private cells = new Map<string, T[]>();
  private large: T[] = [];
  private all: T[] = [];
  constructor(private cellSize = 256) {}
  private range(rect: Bounds) {
    return { x1: Math.floor(rect.left / this.cellSize), y1: Math.floor(rect.top / this.cellSize),
      x2: Math.floor(rect.right / this.cellSize), y2: Math.floor(rect.bottom / this.cellSize) };
  }
  add(item: T) {
    this.all.push(item);
    const { x1, y1, x2, y2 } = this.range(item.rect);
    if ((x2-x1+1)*(y2-y1+1) > 4096) { this.large.push(item); return; }
    for (let x=x1; x<=x2; x++) for (let y=y1; y<=y2; y++) {
      const key = `${x},${y}`;
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(item); else this.cells.set(key, [item]);
    }
  }
  query(rect: Bounds): T[] {
    const { x1, y1, x2, y2 } = this.range(rect);
    const found = new Set<T>(this.large);
    if ((x2-x1+1)*(y2-y1+1) > 4096) this.all.forEach(item => found.add(item));
    else for (let x=x1; x<=x2; x++) for (let y=y1; y<=y2; y++) {
      this.cells.get(`${x},${y}`)?.forEach(item => found.add(item));
    }
    return [...found].filter(item => item.rect.left <= rect.right && item.rect.right >= rect.left && item.rect.top <= rect.bottom && item.rect.bottom >= rect.top);
  }
}
