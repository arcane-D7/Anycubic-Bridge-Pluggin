import { useCallback, useRef } from "react";

/**
 * Hand-rolled resizable panel divider (R0). Avoids a third-party layout dep:
 * the parent holds the panel size state and applies CSS variables on the layout
 * root; this component only reports pointer-driven size changes on drag.
 * Pointer capture keeps dragging smooth and works inside WebView2.
 */

interface PanelDividerProps {
  readonly size: number;
  readonly minSize: number;
  readonly maxSize: number;
  readonly axis: "vertical" | "horizontal";
  readonly onSizeChange: (size: number) => void;
  readonly ariaLabel?: string;
  readonly style?: React.CSSProperties;
}

export function PanelDivider({
  size,
  minSize,
  maxSize,
  axis,
  onSizeChange,
  ariaLabel,
  style,
}: PanelDividerProps) {
  const lastRef = useRef<number | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const el = e.currentTarget;
      el.setPointerCapture(e.pointerId);

      const onMove = (ev: globalThis.PointerEvent) => {
        const cur = axis === "vertical" ? ev.clientX : ev.clientY;
        if (lastRef.current !== null) {
          const delta = axis === "vertical" ? cur - lastRef.current : lastRef.current - cur;
          const next = Math.max(minSize, Math.min(maxSize, sizeRef.current + delta));
          onSizeChange(next);
        }
        lastRef.current = cur;
      };
      const onUp = () => {
        lastRef.current = null;
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.releasePointerCapture(e.pointerId);
      };
      lastRef.current = axis === "vertical" ? e.clientX : e.clientY;
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
    },
    [axis, minSize, maxSize, onSizeChange],
  );

  return (
    <div
      role="separator"
      aria-orientation={axis === "vertical" ? "vertical" : "horizontal"}
      aria-label={
        ariaLabel ?? (axis === "vertical" ? "Resize object tree panel" : "Resize timeline panel")
      }
      className={`panel-divider panel-divider-${axis}`}
      onPointerDown={onPointerDown}
      style={style}
      data-testid={`divider-${axis}`}
    />
  );
}
