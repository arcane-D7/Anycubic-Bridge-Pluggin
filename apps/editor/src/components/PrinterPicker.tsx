import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePrinters } from "@/state/printers";
import { useI18n } from "@/state/i18n";
import { useOperatorProfile } from "@/profile/useOperatorProfile";
import { Icon } from "./icons";
import { PrinterList } from "./printer-list";
import { printerEnvRaw } from "@/lib/printer-env";

/**
 * S9.5-003 printer picker (G43) — header popover that lists printers
 * discovered from `ANYCUBIC_PRINTER_IPS` (env) with a connection LED per
 * entry. Selecting a printer ARMS the send flow (the actual send is gated by
 * the S9.5-004 confirmation dialog — the picker only marks the target).
 *
 * LED states: probing (pulsing amber) → online (green) / offline (red).
 * P1-2: the list body is shared with the Device panel via `PrinterList`.
 * P1-8: when no LAN printer is armed but the operator profile names a
 * machine (Slicer Settings → Printer), the trigger shows that machine as a
 * static label — the Settings config is a real printer, so the header must
 * reflect it instead of "No printer".
 * The env value is read ONLY here (the React layer owns import.meta.env);
 * the pure core + bridge lane stay headless-testable.
 */

export function PrinterPicker() {
  const t = useI18n((s) => s.t);
  const printers = usePrinters((s) => s.printers);
  const probing = usePrinters((s) => s.probing);
  const selectedId = usePrinters((s) => s.selectedId);
  const hint = usePrinters((s) => s.hint);
  const lastProbedAt = usePrinters((s) => s.lastProbedAt);
  const refresh = usePrinters((s) => s.refresh);
  const select = usePrinters((s) => s.select);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [profile] = useOperatorProfile();

  const rawEnv = useMemo(() => printerEnvRaw(), []);
  const selected = useMemo(
    () => printers.find((p) => p.id === selectedId) ?? null,
    [printers, selectedId],
  );
  // P1-8 — headline label: armed LAN printer → its IP; else the operator
  // profile machine name; else the empty-state hint.
  const triggerLabel = useMemo(() => {
    if (selected) return selected.ip;
    if (profile.displayName) return profile.displayName;
    return printers.length > 0 ? t("printer.trigger.pick") : t("printer.trigger.none");
  }, [selected, profile.displayName, printers.length, t]);

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
      <summary aria-label={t("printer.summary.aria")} title={t("printer.summary.title")}>
        <span className="printer-picker-trigger">
          <Icon name="printer" size={14} />
          <span className="printer-picker-trigger-label">{triggerLabel}</span>
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
      <section className="printer-picker-panel" aria-label={t("printer.panel.aria")}>
        <PrinterList
          printers={printers}
          probing={probing}
          hint={hint}
          selectedId={selectedId}
          lastProbedAt={lastProbedAt}
          sourceLabel="env"
          onRefresh={onRefresh}
          onSelect={onPick}
        />
      </section>
    </details>
  );
}
