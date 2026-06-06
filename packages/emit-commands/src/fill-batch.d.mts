// Types for the plain-JS fill-batch.mjs (single-sourced algorithm; see fill.ts for the
// typed re-export and PlacedCell).
export interface FillBatchCell {
  x: number;
  y: number;
  z: number;
  mapColorId: number;
}
export function fillBatch(cells: FillBatchCell[], resolve: (mapColorId: number) => string): string[];
