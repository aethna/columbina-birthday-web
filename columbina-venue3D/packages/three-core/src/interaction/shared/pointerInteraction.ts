export type ViewportScale = {
  x: number;
  y: number;
};

export type PointerInteractionState = {
  active: boolean;
  x: number;
  y: number;
  ndcX: number;
  ndcY: number;
};

/** Single source of truth for canvas pointer interaction in world XY. */
export const pointerInteraction: PointerInteractionState = {
  active: false,
  x: 0,
  y: 0,
  ndcX: 0,
  ndcY: 0,
};

export function setPointerActive(active: boolean): void {
  pointerInteraction.active = active;
}

export function updatePointerInteraction(
  scale: ViewportScale,
  pointer: { x: number; y: number },
): void {
  pointerInteraction.ndcX = pointer.x;
  pointerInteraction.ndcY = pointer.y;
  pointerInteraction.x = pointer.x * scale.x;
  pointerInteraction.y = pointer.y * scale.y;
}

export function resetPointerInteraction(): void {
  pointerInteraction.active = false;
  pointerInteraction.x = 0;
  pointerInteraction.y = 0;
  pointerInteraction.ndcX = 0;
  pointerInteraction.ndcY = 0;
}
