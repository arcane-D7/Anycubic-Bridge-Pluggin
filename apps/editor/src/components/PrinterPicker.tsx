import { useCallback, useEffect, useMemo, useRef } from "react";
import { usePrinters, type PrinterInfo } from "@/state/printers";
import { useI18n } from "@/state/i18n";
import type { MsgKey } from "@/state/i18n-core";
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

function Led({
  printer,
  t,
}: {
  readonly printer: PrinterInfo;
  readonly t: (key: MsgKey, params?: Readonly<Record<string, string>>) => string;
}) {
  const state = printer.reachable === null ? "probing" : printer.reachable ? "online" : "offline";
  const stateLabel =
    state === "probing"
      ? t("printer.led.title.probing")
      : state === "online"
        ? t("printer.led.title.online")
        : t("printer.led.title.offline");
  return (
    <span
      className={`printer-led printer-led-${state}`}
      data-state={state}
      role="img"
      aria-label={t("printer.led.aria", { ip: printer.ip, state: stateLabel })}
      title={stateLabel}
    />
  );
}

function timeAgo(
  at: number | null,
  t: (key: MsgKey, params?: Readonly<Record<string, string>>) => string,
): string {
  if (at === null) return t("printer.timeAgo.never");
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 2) return t("printer.timeAgo.now");
  if (s < 60) return t("printer.timeAgo.seconds", { n: String(s) });
  return t("printer.timeAgo.minutes", { n: String(Math.floor(s / 60)) });
}

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
      <summary aria-label={t("printer.summary.aria")} title={t("printer.summary.title")}>
        <span className="printer-picker-trigger">
          <Icon name="printer" size={14} />
          <span className="printer-picker-trigger-label">
            {selected
              ? selected.ip
              : printers.length > 0
                ? t("printer.trigger.pick")
                : t("printer.trigger.none")}
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
      <section className="printer-picker-panel" aria-label={t("printer.panel.aria")}>
        <header className="printer-picker-head">
          <span className="printer-picker-title">{t("printer.panel.title")}</span>
          <button
            type="button"
            className="printer-picker-refresh"
            onClick={onRefresh}
            disabled={probing}
            aria-label={t("printer.refresh.aria")}
            title={t("printer.refresh.title")}
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
            {t("printer.empty", { env: "ANYCUBIC_PRINTER_IPS" })}
          </p>
        ) : (
          <ul className="printer-picker-list" role="listbox" aria-label={t("printer.list.aria")}>
            {printers.map((p) => (
              <li key={p.id} role="option" aria-selected={p.id === selectedId}>
                <button
                  type="button"
                  className="printer-picker-row"
                  data-selected={p.id === selectedId}
                  onClick={() => onPick(p.id)}
                  title={t("printer.row.title", { ip: p.ip })}
                >
                  <Led printer={p} t={t} />
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
            {probing
              ? t("printer.foot.probing")
              : t("printer.foot.refreshed", {
                  timeAgo: timeAgo(lastProbedAt, t),
                })}
          </span>
          <span className="printer-picker-source">env</span>
        </footer>
      </section>
    </details>
  );
}
