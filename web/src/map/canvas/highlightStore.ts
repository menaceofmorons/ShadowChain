import { createContext, useContext, useSyncExternalStore } from 'react';

export type NodeMark = 'none' | 'group' | 'selected';

export interface HighlightStore {
  mark: (key: string) => NodeMark;
  subscribe: (key: string, listener: () => void) => () => void;
  set: (selected: string | null, group: readonly string[]) => void;
}

export function createHighlightStore(): HighlightStore {
  let selected: string | null = null;
  let group: ReadonlySet<string> = new Set();
  const listeners = new Map<string, Set<() => void>>();

  const markOf = (key: string, sel: string | null, grp: ReadonlySet<string>): NodeMark => {
    if (key === sel) {
      return 'selected';
    }
    return grp.has(key) ? 'group' : 'none';
  };

  return {
    mark: (key) => markOf(key, selected, group),
    subscribe: (key, listener) => {
      const set = listeners.get(key) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(key, set);
      return () => {
        set.delete(listener);
      };
    },
    set: (nextSelected, nextGroup) => {
      const nextSet = new Set(nextGroup);
      const touched = new Set<string>([...group, ...nextSet]);
      for (const key of [selected, nextSelected]) {
        if (key !== null) {
          touched.add(key);
        }
      }
      const changed = [...touched].filter((key) => markOf(key, selected, group) !== markOf(key, nextSelected, nextSet));
      selected = nextSelected;
      group = nextSet;
      for (const key of changed) {
        listeners.get(key)?.forEach((listener) => {
          listener();
        });
      }
    },
  };
}

export const HighlightContext = createContext<HighlightStore>(createHighlightStore());

export function useNodeMark(key: string): NodeMark {
  const store = useContext(HighlightContext);
  return useSyncExternalStore(
    (listener) => store.subscribe(key, listener),
    () => store.mark(key),
  );
}
