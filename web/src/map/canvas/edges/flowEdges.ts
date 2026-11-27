import type { ConnectionEncoding } from '../../encoding';
import type { LayoutMode } from '../../layout/types';
import type { CanvasEdge, CanvasNode } from '../canvasAdapter';
import { NEUTRAL_ENCODINGS } from './canvasEdges';
import type { ConnectorEdgeType } from './ConnectorEdge';
import type { Size } from './connectorRouting';

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

const sameSize = (a: Size, b: Size): boolean => a.width === b.width && a.height === b.height;

const sameEdge = (a: ConnectorEdgeType, b: ConnectorEdgeType): boolean =>
  a.source === b.source &&
  a.target === b.target &&
  a.type === b.type &&
  a.data !== undefined &&
  b.data !== undefined &&
  a.data.mode === b.data.mode &&
  sameSize(a.data.sourceSize, b.data.sourceSize) &&
  sameSize(a.data.targetSize, b.data.targetSize) &&
  sameEncodings(a.data.encodings, b.data.encodings);

export function buildFlowEdges(
  nodes: readonly CanvasNode[],
  edges: readonly CanvasEdge[],
  mode: LayoutMode,
  sizeOf: (node: CanvasNode) => Size,
  cache: EdgeCache,
): { edges: ConnectorEdgeType[]; cache: EdgeCache } {
  const sizes = new Map<string, Size>(nodes.map((node) => [node.key, sizeOf(node)]));
  const sizeOfKey = (key: string): Size => sizes.get(key) ?? { width: 0, height: 0 };
  const next: EdgeCache = new Map();
  const built = edges.map((edge) => {
    const fresh: ConnectorEdgeType = {
      id: edge.connectionId < 0 ? `${edge.sourceKey}>${edge.targetKey}` : String(edge.connectionId),
      source: edge.sourceKey,
      target: edge.targetKey,
      type: mode === 'radial' ? 'straight' : 'default',
      data: {
        mode,
        sourceSize: sizeOfKey(edge.sourceKey),
        targetSize: sizeOfKey(edge.targetKey),
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
