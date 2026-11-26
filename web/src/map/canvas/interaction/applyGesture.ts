import type { MapSession } from '../../session';
import type { CanvasGesture } from './gestures';

export async function applyGesture(session: MapSession, gesture: CanvasGesture): Promise<void> {
  switch (gesture.type) {
    case 'drag-node':
      await session.dragNode(gesture.key, gesture.to);
      return;
    case 'drag-node-alone':
      await session.dragNodeAlone(gesture.key, gesture.to);
      return;
    case 'drag-group':
      await session.dragGroup(gesture.keys, gesture.delta);
      return;
    case 'move-root':
      await session.moveRoot(session.store.rootOffset() + gesture.delta);
      return;
    case 'reset-position':
      await session.resetPosition(gesture.key);
      return;
    case 'set-collapsed':
      await session.setCollapsed(gesture.key, gesture.collapsed);
      return;
  }
}
