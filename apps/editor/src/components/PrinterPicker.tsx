import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePrinters, type PrinterInfo } from "@/state/printers";
import { Icon } from "./icons";

/**
 * S9.5-003 printer picker (G43) — header popover that lists printers
 * discovered from `ANYCUBIC_PRINTER_IPS` (env) with a connection LED per
 * entry. Selecting a printer ARMS the send flow (the actual send is gated by
 * the S9.5-004 confirmation dialog — the picker only marks the target).
 *
 * LED states: probing (pulsing amber) → online (green) / offline (red).
 * The env value is read ONLY here (the React layer owns import.meta.env);
 * the pure core + bridge lane stay headless-testable.
 */

function printerEnvRaw(): string {
  // Vite exposes ALL env vars on import.meta.env with a Record index type;
  // the REAL value comes from the machine, never hardcoded in source.
  return (import.meta.env.ANYCUBIC_PRINTER_IPS as string | undefined) ?? "";
}

function Led({ printer }: { readonly printer: PrinterInfo }) {
  const state = printer.reachable === null ? "probing" : printer.reachable ? "online" : "offline";
  return (
    <span
      className={`printer-led printer-led-${state}`}
      data-state={state}
      role="img"
      aria-label={`${printer.ip} ${state}`}
      title={state === "probing" ? "Probing…" : state === "online" ? "Online" : "Offline"}
    />
  );
}

function timeAgo(at: number | null): string {
  if (at === null) return "not yet probed";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export function PrinterPicker() {
  const printers = usePrinters((s) => s.printers);
  const probing = usePrinters((s) => s.probing);
  const selectedId = usePrinters((s) => s.selectedId);
  const hint = usePrinters((s) => s.hint);
  const lastProbedAt = usePrinters((s) => s.lastProbedAt);
  const refresh = usePrinters((s) => s.refresh);
  const select = usePrinters((s) => s.select);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  const rawEnv = useMemo(() => printerEnvRaw(), []);
  const selected = useMemo(
    () => printers.find((p) => p.id === selectedId) ?? null,
    [printers, selectedId],
  );

  const onRefresh = useCallback(() => {
    void refresh(rawEnv);
  }, [rawEnv, refresh]);

  // Discover + probe on mount (and when the env list changes).
  useEffect(() => {
    void refresh(rawEnv);
  }, [rawEnv, refresh]);

  const close = useCallback(() => {
    detailsRef.current?.removeAttribute("open");
  }, []);

  const onPick = useCallback(
    (id: string) => {
      select(id);
      close();
    },
    [close, select],
  );

  return (
    <details className="printer-picker" ref={detailsRef} data-testid="printer-picker">
      <summary aria-label="Select printer" title="Printer target">
        <span className="printer-picker-trigger">
          <Icon name="printer" size={14} />
          <span className="printer-picker-trigger-label">
            {selected ? selected.ip : printers.length > 0 ? "Pick printer" : "No printer"}
          </span>
          {selected ? (
            <span
              className={`printer-led printer-led-${selected.reachable === null ? "probing" : selected.reachable ? "online" : "offline"}`}
              data-state={
                selected.reachable === null ? "probing" : selected.reachable ? "online" : "offline"
              }
              role="img"
            />
          ) : null}
          <Icon name="chevron-down" size={12} />
        </span>
      </summary>
      <section className="printer-picker-panel" aria-label="Discovered printers">
        <header className="printer-picker-head">
          <span className="printer-picker-title">Printer target</span>
          <button
            type="button"
            className="printer-picker-refresh"
            onClick={onRefresh}
            disabled={probing}
            aria-label="Re-probe printers"
            title="Re-probe reachability"
          >
            <Icon
              name="refresh"
              size={12}
              className={probing ? "printer-picker-spin" : undefined}
            />
          </button>
        </header>

        {hint ? <p className="printer-picker-hint">{hint}</p> : null}

        {printers.length === 0 ? (
          <p className="printer-picker-empty" data-testid="printer-picker-empty">
            No printers discovered. Set <code>ANYCUBIC_PRINTER_IPS</code> (comma-separated IPs).
          </p>
        ) : (
          <ul className="printer-picker-list" role="listbox" aria-label="Printers">
            {printers.map((p) => (
              <li key={p.id} role="option" aria-selected={p.id === selectedId}>
                <button
                  type="button"
                  className="printer-picker-row"
                  data-selected={p.id === selectedId}
                  onClick={() => onPick(p.id)}
                  title={`Arm send target ${p.ip}`}
                >
                  <Led printer={p} />
                  <span className="printer-picker-row-main">
                    <span className="printer-picker-row-name">{p.name}</span>
                    <span className="printer-picker-row-ip">{p.ip}</span>
                  </span>
                  {p.id === selectedId ? (
                    <Icon name="check" size={12} className="printer-picker-check" />
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}

        <footer className="printer-picker-foot">
          <span className="printer-picker-meta">
            {probing ? "probing…" : `refreshed ${timeAgo(lastProbedAt)}`}
          </span>
          <span className="printer-picker-source">env</span>
        </footer>
      </section>
    </details>
  );
}
