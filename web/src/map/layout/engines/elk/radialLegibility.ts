// TUNE: largest allowed ratio between the gaps of adjacent rings (root to ring 1 counts as a gap); proposed from radial-ex-1.png and radial-ex-2.png, where gaps differ by under 2x.
export const RADIAL_MAX_GAP_RATIO = 2;

// TUNE: largest allowed overall width or height of the radial layout at 150 nodes, in pixels, for seeds 7 and 8.
export const RADIAL_MAX_EXTENT_AT_150 = 9000;

export function smoothRingRadii(minRadii: readonly number[], minStep: number, maxGapRatio: number): number[] {
  const count = minRadii.length;
  const lifted = minRadii.map((radius, depth) => {
    let lift = radius;
    for (let outer = depth + 1; outer < count; outer += 1) {
      lift = Math.max(lift, ((minRadii[outer] as number) * depth) / outer);
    }
    return lift;
  });
  const gaps = lifted.map((radius, depth) =>
    depth === 0 ? 0 : Math.max(minStep, radius - (lifted[depth - 1] as number)),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (let depth = 1; depth < count; depth += 1) {
      const neighbours = [gaps[depth - 1], gaps[depth + 1]].filter(
        (gap): gap is number => gap !== undefined && gap > 0,
      );
      const floor = Math.max(0, ...neighbours) / maxGapRatio;
      if ((gaps[depth] as number) < floor - 1e-9) {
        gaps[depth] = floor;
        changed = true;
      }
    }
  }
  let radius = 0;
  return gaps.map((gap) => (radius += gap));
}
