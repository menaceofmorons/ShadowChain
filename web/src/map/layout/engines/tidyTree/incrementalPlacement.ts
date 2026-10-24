import type { ChainNode } from '../../../model/types';
import { nodeSize } from '../../engineOptions';
import type { EngineOptions } from '../../engineOptions';
import type { IncrementalLayoutRequest, LayoutMode, PlacedNode } from '../../types';
import { childrenOf, extentOf, toSlot } from './tidyTreeGeometry';
import type { Slot } from './tidyTreeGeometry';

const EPSILON = 1e-6;

interface Rect {
  readonly across: number;
  readonly along: number;
  readonly acrossSize: number;
  readonly alongSize: number;
}

interface Member {
  readonly key: string;
  readonly rect: Rect;
}

const acrossEnd = (rect: Rect): number => rect.across + rect.acrossSize;

const alongOverlaps = (a: Rect, b: Rect): boolean =>
  a.along < b.along + b.alongSize - EPSILON && b.along < a.along + a.alongSize - EPSILON;

const clashes = (a: Rect, b: Rect, margin: number): boolean =>
  alongOverlaps(a, b) && a.across < acrossEnd(b) + margin - EPSILON && b.across < acrossEnd(a) + margin - EPSILON;

const shifted = (rect: Rect, dAcross: number, dAlong: number): Rect => ({
  ...rect,
  across: rect.across + dAcross,
  along: rect.along + dAlong,
});

const vanishedRect = (prior: PlacedNode, mode: LayoutMode, options: EngineOptions): Rect => {
  const kind = prior.alias ? 'alias' : prior.collapsed ? 'collapsed' : 'primary';
  const { width, height } = nodeSize({ kind } as ChainNode, options);
  const slot = toSlot(mode, prior.x, prior.y);
  const across = mode === 'top-down' ? width : height;
  const along = mode === 'top-down' ? height : width;
  return { across: slot.across, along: slot.along, acrossSize: across, alongSize: along };
};

class Placement {
  private readonly rects = new Map<string, Rect>();

  constructor(
    private readonly mode: LayoutMode,
    private readonly options: EngineOptions,
    private readonly pinned: ReadonlySet<string>,
  ) {}

  get margin(): number {
    return this.options.siblingSpacing;
  }

  has(key: string): boolean {
    return this.rects.has(key);
  }

  isPinned(key: string): boolean {
    return this.pinned.has(key);
  }

  rectOf(key: string): Rect | undefined {
    return this.rects.get(key);
  }

  remember(node: ChainNode, slot: Slot): void {
    const extent = extentOf(node, this.mode, this.options);
    this.rects.set(node.keyString, {
      across: slot.across,
      along: slot.along,
      acrossSize: extent.across,
      alongSize: extent.along,
    });
  }

  freshMember(node: ChainNode): Member {
    const extent = extentOf(node, this.mode, this.options);
    return { key: node.keyString, rect: { across: 0, along: 0, acrossSize: extent.across, alongSize: extent.along } };
  }

  groupOf(node: ChainNode): ChainNode[] {
    const out: ChainNode[] = [];
    const visit = (current: ChainNode): void => {
      out.push(current);
      for (const child of childrenOf(current)) {
        if (this.rects.has(child.keyString) && !this.pinned.has(child.keyString)) {
          visit(child);
        }
      }
    };
    visit(node);
    return out;
  }

  membersOf(nodes: readonly ChainNode[]): Member[] {
    return nodes.map((node) => ({ key: node.keyString, rect: this.rects.get(node.keyString) as Rect }));
  }

  slots(): Map<string, Slot> {
    return new Map([...this.rects].map(([key, rect]) => [key, { across: rect.across, along: rect.along }]));
  }

  private moveGroup(members: readonly Member[], dAcross: number, dAlong: number): void {
    for (const member of members) {
      this.rects.set(member.key, shifted(member.rect, dAcross, dAlong));
    }
  }

  private rightShift(members: readonly Rect[], excluded: ReadonlySet<string>): number {
    let shift = 0;
    for (;;) {
      let next = shift;
      for (const member of members) {
        const probe = shifted(member, shift, 0);
        for (const [key, other] of this.rects) {
          if (!excluded.has(key) && clashes(probe, other, this.margin)) {
            next = Math.max(next, acrossEnd(other) + this.margin - member.across);
          }
        }
      }
      if (next === shift) {
        return shift;
      }
      shift = next;
    }
  }

  private leftRoom(members: readonly Rect[], excluded: ReadonlySet<string>): number {
    let room = Number.POSITIVE_INFINITY;
    for (const member of members) {
      for (const [key, other] of this.rects) {
        if (!excluded.has(key) && alongOverlaps(member, other) && acrossEnd(other) <= member.across + EPSILON) {
          room = Math.min(room, member.across - (acrossEnd(other) + this.margin));
        }
      }
    }
    return Math.max(0, room);
  }

  private bandSlack(): number {
    const { nodeWidth, nodeHeight, aliasWidth, aliasHeight, collapsedWidth, collapsedHeight } = this.options;
    const extents =
      this.mode === 'top-down' ? [nodeHeight, aliasHeight, collapsedHeight] : [nodeWidth, aliasWidth, collapsedWidth];
    return Math.max(...extents) - Math.min(...extents);
  }

  isDetached(node: ChainNode, parent: ChainNode): boolean {
    const rect = this.rects.get(node.keyString);
    const parentRect = this.rects.get(parent.keyString);
    if (rect === undefined || parentRect === undefined || this.pinned.has(node.keyString)) {
      return false;
    }
    const siblings = childrenOf(parent);
    const autos = siblings.filter(
      (sibling) => this.rects.has(sibling.keyString) && !this.pinned.has(sibling.keyString),
    );
    const index = autos.indexOf(node);
    const before = autos[index - 1];
    const after = autos[index + 1];
    const outOfOrder =
      (before !== undefined && (this.rects.get(before.keyString) as Rect).across >= rect.across) ||
      (after !== undefined && (this.rects.get(after.keyString) as Rect).across <= rect.across);
    if (outOfOrder) {
      return true;
    }
    if (this.pinned.has(parent.keyString)) {
      return false;
    }
    const drift = rect.along - (parentRect.along + parentRect.alongSize + this.options.levelSpacing);
    if (drift < -EPSILON || drift > this.bandSlack() + EPSILON) {
      return true;
    }
    return (
      siblings.length === 1 &&
      Math.abs(rect.across + rect.acrossSize / 2 - (parentRect.across + parentRect.acrossSize / 2)) > EPSILON
    );
  }

  place(node: ChainNode, parent: ChainNode | undefined, members: readonly Member[]): void {
    const lead = members[0] as Member;
    const parentRect = parent === undefined ? undefined : this.rects.get(parent.keyString);
    let along = 0;
    let across = 0;
    const later: ChainNode[] = [];
    if (parent !== undefined && parentRect !== undefined) {
      along = parentRect.along + parentRect.alongSize + this.options.levelSpacing;
      const siblings = childrenOf(parent);
      const index = siblings.indexOf(node);
      const earlier = siblings.slice(0, index).flatMap((sibling) => this.rects.get(sibling.keyString) ?? []);
      later.push(...siblings.slice(index + 1).filter((sibling) => this.rects.has(sibling.keyString)));
      if (earlier.length > 0) {
        across = Math.max(...earlier.map(acrossEnd)) + this.margin;
      } else {
        const centred = parentRect.across + parentRect.acrossSize / 2 - lead.rect.acrossSize / 2;
        const laterStarts = later.map((sibling) => (this.rects.get(sibling.keyString) as Rect).across);
        across =
          laterStarts.length > 0
            ? Math.min(centred, Math.min(...laterStarts) - lead.rect.acrossSize - this.margin)
            : centred;
      }
    }
    const dAcross = across - lead.rect.across;
    const dAlong = along - lead.rect.along;
    const keys = new Set(members.map((member) => member.key));
    const clear = this.rightShift(
      members.map((member) => shifted(member.rect, dAcross, dAlong)),
      keys,
    );
    this.moveGroup(members, dAcross + clear, dAlong);
    this.keepSiblingOrder(later, acrossEnd(this.rects.get(lead.key) as Rect));
  }

  private keepSiblingOrder(later: readonly ChainNode[], leadEnd: number): void {
    let previousEnd = leadEnd;
    for (const sibling of later) {
      const rect = this.rects.get(sibling.keyString) as Rect;
      if (!this.pinned.has(sibling.keyString)) {
        const need = previousEnd + this.margin - rect.across;
        if (need > EPSILON) {
          const members = this.membersOf(this.groupOf(sibling));
          const keys = new Set(members.map((member) => member.key));
          const clear = this.rightShift(
            members.map((member) => shifted(member.rect, need, 0)),
            keys,
          );
          this.moveGroup(members, need + clear, 0);
        }
      }
      previousEnd = Math.max(previousEnd, acrossEnd(this.rects.get(sibling.keyString) as Rect));
    }
  }

  repack(gaps: readonly Rect[], nodes: readonly ChainNode[]): void {
    const carried = new Set<string>();
    for (const gap of this.mergeGaps(gaps)) {
      const width = gap.acrossSize + this.margin;
      const candidates = nodes
        .filter((node) => {
          const rect = this.rects.get(node.keyString);
          return (
            rect !== undefined &&
            !this.pinned.has(node.keyString) &&
            alongOverlaps(rect, gap) &&
            rect.across >= gap.across - EPSILON
          );
        })
        .sort(
          (a, b) =>
            (this.rects.get(a.keyString) as Rect).across - (this.rects.get(b.keyString) as Rect).across ||
            (a.keyString < b.keyString ? -1 : 1),
        );
      for (const candidate of candidates) {
        if (carried.has(candidate.keyString)) {
          continue;
        }
        const members = this.membersOf(this.groupOf(candidate));
        const keys = new Set(members.map((member) => member.key));
        const delta = Math.min(
          width,
          this.leftRoom(
            members.map((member) => member.rect),
            keys,
          ),
        );
        if (delta > EPSILON) {
          this.moveGroup(members, -delta, 0);
        }
        keys.forEach((key) => carried.add(key));
      }
    }
  }

  private mergeGaps(gaps: readonly Rect[]): Rect[] {
    const merged: Rect[] = [];
    for (const gap of [...gaps].sort((a, b) => a.across - b.across)) {
      const index = merged.findIndex(
        (other) => alongOverlaps(other, gap) && gap.across <= acrossEnd(other) + this.margin + EPSILON,
      );
      if (index < 0) {
        merged.push(gap);
      } else {
        const other = merged[index] as Rect;
        const along = Math.min(other.along, gap.along);
        const across = Math.min(other.across, gap.across);
        merged[index] = {
          across,
          along,
          acrossSize: Math.max(acrossEnd(other), acrossEnd(gap)) - across,
          alongSize: Math.max(other.along + other.alongSize, gap.along + gap.alongSize) - along,
        };
      }
    }
    return merged.sort((a, b) => a.along - b.along || a.across - b.across);
  }
}

export function incrementalSlots(request: IncrementalLayoutRequest, options: EngineOptions): Map<string, Slot> {
  const { mode, tree } = request;
  const nodes = new Map(tree.nodes.map((node) => [node.keyString, node]));
  const manual = new Map(request.manualPositions.filter((p) => nodes.has(p.nodeKey)).map((p) => [p.nodeKey, p]));
  const removed = new Set(request.removedNodeKeys);
  const placement = new Placement(mode, options, new Set(manual.keys()));

  const gaps: Rect[] = [];
  for (const prior of request.previous) {
    const node = nodes.get(prior.nodeKey);
    if (node === undefined || removed.has(prior.nodeKey)) {
      if (prior.source !== 'manual' && !manual.has(prior.nodeKey)) {
        gaps.push(vanishedRect(prior, mode, options));
      }
    } else if (!manual.has(prior.nodeKey)) {
      placement.remember(node, toSlot(mode, prior.x, prior.y));
    }
  }
  for (const position of manual.values()) {
    placement.remember(nodes.get(position.nodeKey) as ChainNode, toSlot(mode, position.x, position.y));
  }

  placement.repack(gaps, tree.nodes);
  const hasRemoval = gaps.length > 0 || removed.size > 0;

  const parents = new Map<string, ChainNode>();
  const ordered: ChainNode[] = [];
  const visit = (node: ChainNode): void => {
    ordered.push(node);
    for (const child of childrenOf(node)) {
      parents.set(child.keyString, node);
      visit(child);
    }
  };
  visit(tree.root);
  for (const node of ordered) {
    const parent = parents.get(node.keyString);
    if (!placement.has(node.keyString)) {
      placement.place(node, parent, [placement.freshMember(node)]);
      continue;
    }
    if (hasRemoval && parent !== undefined && placement.isDetached(node, parent)) {
      placement.place(node, parent, placement.membersOf(placement.groupOf(node)));
    }
  }
  return placement.slots();
}
