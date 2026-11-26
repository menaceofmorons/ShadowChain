import type { CanvasGesture, MenuItem } from './gestures';

export interface ContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
  readonly onChoose: (gesture: CanvasGesture) => void;
  readonly onClose: () => void;
}

export function ContextMenu({ x, y, items, onChoose, onClose }: ContextMenuProps) {
  return (
    <div
      role="menu"
      data-testid="node-menu"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 10,
        background: '#fff',
        border: '1px solid #8a96a3',
        borderRadius: 3,
        display: 'flex',
        flexDirection: 'column',
        font: '12px sans-serif',
      }}
    >
      {items.map((item) => (
        <button
          key={item.id}
          role="menuitem"
          data-menu-item={item.id}
          style={{ textAlign: 'left', padding: '4px 12px', border: 'none', background: 'none', cursor: 'pointer' }}
          onClick={() => {
            onChoose(item.gesture);
            onClose();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
