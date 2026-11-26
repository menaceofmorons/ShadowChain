import type { ConnectionId } from '../model/nodeKey';
import type { ChainEdge, ConnectionAttributes, ConnectionSize, LifeStage, MassStatus } from '../model/types';

export type BadgeLetter = 'S' | 'M' | 'F' | 'C';

export type DashPattern = readonly number[];

export interface ConnectionTheme {
  readonly massColour: Readonly<Record<MassStatus, string>>;
  readonly massWidth: Readonly<Record<MassStatus, number>>;
  readonly neutralColour: string;
  readonly neutralWidth: number;
  readonly solid: DashPattern;
  readonly dashed: DashPattern;
  readonly dotSpaceDot: DashPattern;
}

export interface ConnectionEncoding {
  readonly colour: string;
  readonly width: number;
  readonly dash: DashPattern;
  readonly badge: BadgeLetter | null;
}

export interface EdgeEncoding extends ConnectionEncoding {
  readonly connectionId: ConnectionId;
}

export const DEFAULT_CONNECTION_THEME: ConnectionTheme = {
  massColour: { fresh: '#3fa34d', reduced: '#e0a030', critical: '#d64545' },
  massWidth: { fresh: 4, reduced: 2.5, critical: 1.25 },
  neutralColour: '#8a8f98',
  neutralWidth: 2.5,
  solid: [],
  dashed: [8, 4],
  dotSpaceDot: [2, 4],
};

const AGE_PATTERN_KEY: Readonly<Record<LifeStage, 'solid' | 'dashed' | 'dotSpaceDot'>> = {
  1: 'solid',
  2: 'solid',
  3: 'dashed',
  4: 'dotSpaceDot',
};

const SIZE_BADGE: Readonly<Record<ConnectionSize, BadgeLetter | null>> = {
  small: 'S',
  medium: 'M',
  large: null,
  freighter: 'F',
  capital: 'C',
  unknown: null,
};

export const connectionEncoding = (
  attributes: ConnectionAttributes,
  theme: ConnectionTheme = DEFAULT_CONNECTION_THEME,
): ConnectionEncoding => {
  const { massStatus, lifeStage, size } = attributes;
  return {
    colour: massStatus === undefined ? theme.neutralColour : theme.massColour[massStatus],
    width: massStatus === undefined ? theme.neutralWidth : theme.massWidth[massStatus],
    dash: lifeStage === undefined ? theme.solid : theme[AGE_PATTERN_KEY[lifeStage]],
    badge: size === undefined ? null : SIZE_BADGE[size],
  };
};

export const edgeEncodings = (
  edge: ChainEdge,
  attributesById: (id: ConnectionId) => ConnectionAttributes,
  theme: ConnectionTheme = DEFAULT_CONNECTION_THEME,
): readonly EdgeEncoding[] =>
  [edge.connectionId, ...edge.parallelConnectionIds].map((connectionId) => ({
    connectionId,
    ...connectionEncoding(attributesById(connectionId), theme),
  }));
