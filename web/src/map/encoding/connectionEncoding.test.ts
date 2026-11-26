import { describe, expect, it } from 'vitest';
import type { ConnectionSize, LifeStage, MassStatus } from '../model/types';
import { connectionEncoding, DEFAULT_CONNECTION_THEME as theme, edgeEncodings } from './connectionEncoding';

describe('connectionEncoding mass', () => {
  it.each<[MassStatus, string]>([
    ['fresh', theme.massColour.fresh],
    ['reduced', theme.massColour.reduced],
    ['critical', theme.massColour.critical],
  ])('%s maps to its colour and weight', (massStatus, colour) => {
    const encoding = connectionEncoding({ massStatus });
    expect(encoding.colour).toBe(colour);
    expect(encoding.width).toBe(theme.massWidth[massStatus]);
  });

  it('orders widths fresh > reduced > critical and colours are distinct', () => {
    expect(theme.massWidth.fresh).toBeGreaterThan(theme.massWidth.reduced);
    expect(theme.massWidth.reduced).toBeGreaterThan(theme.massWidth.critical);
    expect(new Set(Object.values(theme.massColour)).size).toBe(3);
  });
});

describe('connectionEncoding age', () => {
  it.each<[LifeStage, readonly number[]]>([
    [1, theme.solid],
    [2, theme.solid],
    [3, theme.dashed],
    [4, theme.dotSpaceDot],
  ])('stage %i maps to its pattern', (lifeStage, dash) => {
    expect(connectionEncoding({ lifeStage }).dash).toEqual(dash);
  });

  it('keeps the three patterns distinct', () => {
    expect(theme.solid).toEqual([]);
    expect(theme.dashed).not.toEqual(theme.dotSpaceDot);
    expect(theme.dashed.length).toBe(2);
    expect(theme.dotSpaceDot.length).toBe(2);
  });
});

describe('connectionEncoding size', () => {
  it.each<[ConnectionSize, string | null]>([
    ['small', 'S'],
    ['medium', 'M'],
    ['large', null],
    ['freighter', 'F'],
    ['capital', 'C'],
    ['unknown', null],
  ])('%s maps to badge %s', (size, badge) => {
    expect(connectionEncoding({ size }).badge).toBe(badge);
  });
});

describe('connectionEncoding defaults', () => {
  it('draws the neutral default for absent attributes', () => {
    expect(connectionEncoding({})).toEqual({
      colour: theme.neutralColour,
      width: theme.neutralWidth,
      dash: theme.solid,
      badge: null,
    });
  });

  it('uses a supplied theme', () => {
    const custom = { ...theme, neutralColour: '#000000' };
    expect(connectionEncoding({}, custom).colour).toBe('#000000');
  });
});

describe('edgeEncodings', () => {
  it('returns the tree edge first, then each parallel connection', () => {
    const attributes: Record<number, { massStatus: MassStatus; size: ConnectionSize }> = {
      1: { massStatus: 'fresh', size: 'small' },
      2: { massStatus: 'critical', size: 'capital' },
      3: { massStatus: 'reduced', size: 'medium' },
    };
    const result = edgeEncodings({ connectionId: 1, parallelConnectionIds: [2, 3] }, (id) => attributes[id] ?? {});
    expect(result.map((r) => r.connectionId)).toEqual([1, 2, 3]);
    expect(result.map((r) => r.badge)).toEqual(['S', 'C', 'M']);
    expect(result.map((r) => r.colour)).toEqual([
      theme.massColour.fresh,
      theme.massColour.critical,
      theme.massColour.reduced,
    ]);
  });

  it('returns a single encoding when there are no parallels', () => {
    expect(edgeEncodings({ connectionId: 5, parallelConnectionIds: [] }, () => ({}))).toHaveLength(1);
  });
});
