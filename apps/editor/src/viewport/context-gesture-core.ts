export const RIGHT_DRAG_THRESHOLD_PX = 6;

export interface RightGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly suppressMenu: boolean;
}

export function beginRightGesture(pointerId: number, x: number, y: number): RightGesture {
  return { pointerId, startX: x, startY: y, suppressMenu: false };
}

export function moveRightGesture(
  gesture: RightGesture | null,
  pointerId: number,
  x: number,
  y: number,
): RightGesture | null {
  if (!gesture || gesture.pointerId !== pointerId || gesture.suppressMenu) return gesture;
  const dx = x - gesture.startX;
  const dy = y - gesture.startY;
  if (Math.hypot(dx, dy) < RIGHT_DRAG_THRESHOLD_PX) return gesture;
  return { ...gesture, suppressMenu: true };
}

export function cancelRightGesture(gesture: RightGesture | null): RightGesture | null {
  return gesture ? { ...gesture, suppressMenu: true } : null;
}

export function consumeRightGestureMenu(gesture: RightGesture | null): {
  readonly openMenu: boolean;
  readonly next: null;
} {
  return { openMenu: gesture === null || !gesture.suppressMenu, next: null };
}
