export const ALONE_DRAG_MODIFIER = 'altKey' as const;
export const SELECTION_KEY_CODE = 'Shift';
export const MULTI_SELECTION_KEY_CODES: readonly string[] = ['Control', 'Meta'];

export interface ModifierState {
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

export interface DecodedModifiers {
  readonly aloneDrag: boolean;
  readonly rubberBand: boolean;
  readonly toggleSelection: boolean;
}

export function decodeModifiers(state: ModifierState): DecodedModifiers {
  return {
    aloneDrag: state[ALONE_DRAG_MODIFIER] === true,
    rubberBand: state.shiftKey === true,
    toggleSelection: state.ctrlKey === true || state.metaKey === true,
  };
}
