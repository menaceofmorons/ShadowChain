import type { LayoutMode } from '../../layout/types';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export type RootAxis = 'x' | 'y';

export function rootAxisFor(mode: LayoutMode): RootAxis | null {
  switch (mode) {
    case 'top-down':
      return 'x';
    case 'left-to-right':
      return 'y';
    case 'radial':
      return null;
  }
}

export function constrainToRootAxis(mode: LayoutMode, start: Point, proposed: Point): Point {
  switch (rootAxisFor(mode)) {
    case 'x':
      return { x: proposed.x, y: start.y };
    case 'y':
      return { x: start.x, y: proposed.y };
    case null:
      return start;
  }
}

export function acrossDelta(mode: LayoutMode, start: Point, end: Point): number {
  switch (rootAxisFor(mode)) {
    case 'x':
      return end.x - start.x;
    case 'y':
      return end.y - start.y;
    case null:
      return 0;
  }
}
