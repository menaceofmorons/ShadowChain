import type { LayoutEngine } from '../../layout/types';

export type Wait = (milliseconds: number) => void | Promise<void>;

export const busyWait: Wait = (milliseconds) => {
  const end = performance.now() + milliseconds;
  while (performance.now() < end) {
    continue;
  }
};

export const createDelayedEngine = (inner: LayoutEngine, delayMs: number, wait: Wait = busyWait): LayoutEngine => ({
  async layout(request) {
    await wait(delayMs);
    return inner.layout(request);
  },
});
