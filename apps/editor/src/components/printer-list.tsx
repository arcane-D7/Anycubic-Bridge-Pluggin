import type { PrinterInfo } from "@/state/printers";
import { useI18n } from "@/state/i18n";
import type { MsgKey } from "@/state/i18n-core";
import { Icon } from "./icons";

/**
 * P1-2 — shared printer list presentation.
 *
 * Extracted from `PrinterPicker` so the header picker and the Device panel
 * render the SAME discovery data through one component: tri-state LED
 * (probing/online/offline), IP/name rows, refresh button, empty/hint states.
 * Selection state + refresh action stay owned by the caller (both surfaces
 * arm `usePrinters.select` — a pure store write, never a hardware command).
 */

export function printerTimeAgo(
  at: number | null,
  t: (key: MsgKey, params?: Readonly<Record<string, string>>) => string,
): string {
  if (at === null) return t("printer.timeAgo.never");
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 2) return t("printer.timeAgo.now");
  if (s < 60) return t("printer.timeAgo.seconds", { n: String(s) });
  return t("printer.timeAgo.minutes", { n: String(Math.floor(s / 60)) });
}

export function PrinterLed({
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

interface PrinterListProps {
  readonly printers: readonly PrinterInfo[];
  readonly probing: boolean;
  readonly hint: string | null;
  readonly selectedId: string | null;
  readonly lastProbedAt: number | null;
  readonly sourceLabel: string;
  readonly onRefresh: () => void;
  readonly onSelect: (id: string) => void;
}

/**
 * Renders the discovery list with LED + refresh + footer meta. The wrapping
 * `<details>`/popover chrome stays with the header picker; this component is
 * the portable list body (also used by the Device panel empty state).
 */
export function PrinterList({
  printers,
  probing,
  hint,
  selectedId,
  lastProbedAt,
  sourceLabel,
  onRefresh,
  onSelect,
}: PrinterListProps) {
  const t = useI18n((s) => s.t);
  return (
    <>
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
          <Icon name="refresh" size={12} className={probing ? "printer-picker-spin" : undefined} />
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
                onClick={() => onSelect(p.id)}
                title={t("printer.row.title", { ip: p.ip })}
              >
                <PrinterLed printer={p} t={t} />
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
            : t("printer.foot.refreshed", { timeAgo: printerTimeAgo(lastProbedAt, t) })}
        </span>
        <span className="printer-picker-source">{sourceLabel}</span>
      </footer>
    </>
  );
}
