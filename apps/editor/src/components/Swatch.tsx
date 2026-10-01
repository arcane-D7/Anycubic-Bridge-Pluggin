/**
 * S9.6-001 — Color swatch for filament presets (palette UI, not bare
 * numerics). Pure presentational; the color travels as a hex string.
 */

interface SwatchProps {
  readonly color: string;
  readonly label: string;
  readonly size?: number;
  readonly testid?: string;
}

export function Swatch({ color, label, size = 12, testid }: SwatchProps) {
  return (
    <span
      data-testid={testid}
      className="filament-swatch"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        backgroundColor: color,
      }}
      role="img"
      aria-label={`${label} color swatch`}
      title={color}
    />
  );
}
