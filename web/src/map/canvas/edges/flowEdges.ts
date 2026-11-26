import type { ConnectionEncoding } from '../../encoding';
import type { LayoutMode } from '../../layout/types';
import type { CanvasEdge, CanvasNode } from '../canvasAdapter';
import { NEUTRAL_ENCODINGS } from './canvasEdges';
import type { ConnectorEdgeType } from './ConnectorEdge';
import { planSiblings, type BusRank, type Rect, type Size } from './connectorRouting';

export type EdgeCache = Map<string, ConnectorEdgeType>;

const sameEncodings = (a: readonly ConnectionEncoding[], b: readonly ConnectionEncoding[]): boolean =>
  a === b ||
  (a.length === b.length &&
    a.every((x, i) => {
      const y = b[i] as ConnectionEncoding;
      return (
        x.colour === y.colour &&
        x.width === y.width &&
        x.badge === y.badge &&
        x.dash.length === y.dash.length &&
        x.dash.every((value, j) => value === y.dash[j])
      );
    }));

const sameBus = (a: readonly BusRank[], b: readonly BusRank[]): boolean =>
  a.length === b.length && a.every((x, i) => x.rank === (b[i] as BusRank).rank && x.runs === (b[i] as BusRank).runs);

const sameSize = (a: Size, b: Size): boolean => a.width === b.width && a.height === b.height;

const sameEdge = (a: ConnectorEdgeType, b: ConnectorEdgeType): boolean =>
  a.source === b.source &&
  a.target === b.target &&
  a.type === b.type &&
  a.data !== undefined &&
  b.data !== undefined &&
  a.data.mode === b.data.mode &&
  a.data.slotStart === b.data.slotStart &&
  a.data.slots === b.data.slots &&
  sameBus(a.data.bus, b.data.bus) &&
  sameSize(a.data.sourceSize, b.data.sourceSize) &&
  sameSize(a.data.targetSize, b.data.targetSize) &&
  sameEncodings(a.data.encodings, b.data.encodings);

const pathsOf = (edge: CanvasEdge): number => Math.max(1, edge.encodings?.length ?? 1);

interface Placement {
  readonly slotStart: number;
  readonly slots: number;
  readonly bus: readonly BusRank[];
}

export function buildFlowEdges(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  mode: LayoutMode,
  sizeOf: (node: CanvasNode) => Size,
  cache: EdgeCache,
): { edges: ConnectorEdgeType[]; cache: EdgeCache } {
  const rects = new Map<string, Rect>(nodes.map((node) => [node.key, { x: node.x, y: node.y, ...sizeOf(node) }]));
  const bySource = new Map<string, CanvasEdge[]>();
  edges.forEach((edge) => {
    bySource.set(edge.sourceKey, [...(bySource.get(edge.sourceKey) ?? []), edge]);
  });
  const placement = new Map<number, Placement>();
  bySource.forEach((siblings, sourceKey) => {
    const source = rects.get(sourceKey);
    const targets = siblings.map((edge) => rects.get(edge.targetKey));
    if (mode === 'radial' || source === undefined || targets.some((target) => target === undefined)) {
      siblings.forEach((edge) => {
        placement.set(edge.connectionId, { slotStart: 0, slots: 1, bus: [] });
      });
      return;
    }
    const plan = planSiblings(
      mode,
      source,
      siblings.map((edge, index) => ({ target: targets[index] as Rect, paths: pathsOf(edge) })),
    );
    siblings.forEach((edge, index) => {
      const own = plan.plans[index] as { slotStart: number; bus: readonly BusRank[] };
      placement.set(edge.connectionId, { slotStart: own.slotStart, slots: plan.slots, bus: own.bus });
    });
  });
  const next: EdgeCache = new Map();
  const built = edges.map((edge) => {
    const place = placement.get(edge.connectionId) as Placement;
    const fresh: ConnectorEdgeType = {
      id: String(edge.connectionId),
      source: edge.sourceKey,
      target: edge.targetKey,
      type: mode === 'radial' ? 'straight' : 'default',
      data: {
        mode,
        slotStart: place.slotStart,
        slots: place.slots,
        bus: place.bus,
        sourceSize: sizeOfKey(rects, edge.sourceKey),
        targetSize: sizeOfKey(rects, edge.targetKey),
        encodings: edge.encodings ?? NEUTRAL_ENCODINGS,
      },
    };
    const previous = cache.get(fresh.id);
    const chosen = previous !== undefined && sameEdge(previous, fresh) ? previous : fresh;
    next.set(fresh.id, chosen);
    return chosen;
  });
  return { edges: built, cache: next };
}

const FALLBACK_SIZE: Size = { width: 0, height: 0 };

function sizeOfKey(rects: ReadonlyMap<string, Rect>, key: string): Size {
  const rect = rects.get(key);
  return rect === undefined ? FALLBACK_SIZE : { width: rect.width, height: rect.height };
}
