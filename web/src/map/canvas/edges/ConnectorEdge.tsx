import { memo, useMemo } from 'react';
import type { Edge, EdgeProps, EdgeTypes } from '@xyflow/react';
import type { ConnectionEncoding } from '../../encoding';
import type { LayoutMode } from '../../layout/types';
import { BADGE_HEIGHT, BADGE_WIDTH } from './connectorBounds';
import { rectFromHandle, routeConnector, type Size } from './connectorRouting';

export interface ConnectorData extends Record<string, unknown> {
  mode: LayoutMode;
  sourceSize: Size;
  targetSize: Size;
  encodings: readonly ConnectionEncoding[];
}

export type ConnectorEdgeType = Edge<ConnectorData, 'default' | 'straight'>;

const BADGE_FILL = '#1f2933';
const BADGE_TEXT = '#ffffff';

export const dashAttribute = (dash: readonly number[]): string | undefined =>
  dash.length === 0 ? undefined : dash.join(' ');

export const ConnectorEdge = memo(function ConnectorEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<ConnectorEdgeType>) {
  const mode = data?.mode ?? 'top-down';
  const encodings = data?.encodings;
  const sourceSize = data?.sourceSize;
  const targetSize = data?.targetSize;
  const paths = useMemo(() => {
    if (sourceSize === undefined || targetSize === undefined) {
      return [];
    }
    return routeConnector({
      mode,
      source: rectFromHandle(mode, 'source', { x: sourceX, y: sourceY }, sourceSize),
      target: rectFromHandle(mode, 'target', { x: targetX, y: targetY }, targetSize),
      paths: encodings?.length ?? 1,
    });
  }, [mode, sourceX, sourceY, targetX, targetY, sourceSize, targetSize, encodings]);

  return (
    <g data-connector={id} data-source={source} data-target={target}>
      {paths.map((path, pathIndex) => {
        const encoding = encodings?.[pathIndex];
        if (encoding === undefined) {
          return null;
        }
        return (
          <g key={pathIndex} data-path={pathIndex}>
            <path
              d={path.d}
              fill="none"
              stroke={encoding.colour}
              strokeWidth={encoding.width}
              strokeDasharray={dashAttribute(encoding.dash)}
              data-colour={encoding.colour}
              data-width={encoding.width}
              data-dash={encoding.dash.join(' ')}
            />
            {encoding.badge !== null && (
              <g data-badge={encoding.badge} transform={`translate(${String(path.badge.x)} ${String(path.badge.y)})`}>
                <rect
                  x={-BADGE_WIDTH / 2}
                  y={-BADGE_HEIGHT / 2}
                  width={BADGE_WIDTH}
                  height={BADGE_HEIGHT}
                  rx={3}
                  fill={BADGE_FILL}
                />
                <text
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={10}
                  fontWeight="bold"
                  fontFamily="sans-serif"
                  fill={BADGE_TEXT}
                >
                  {encoding.badge}
                </text>
              </g>
            )}
          </g>
        );
      })}
    </g>
  );
});

export const EDGE_TYPES: EdgeTypes = {
  default: ConnectorEdge,
  straight: ConnectorEdge,
};
