import { useEffect, useRef, useState } from "react";
import { useUi, type Toast, type ToastKind } from "@/state/ui";
import { useI18n } from "@/state/i18n";
import { cn } from "@/lib/utils";
import { Icon } from "./icons";

/**
 * Notification bus renderer (S9.1-005, P1-8). Compact bell button pinned to
 * the BOTTOM-LEFT corner (out of the way of the header/printer UI and the
 * viewport footer): shows a count badge, opens an upward popover with the
 * stacked toasts. Each toast keeps the semantic LED + dismiss button.
 *
 * User feedback (2026-10-06): toasts stacked top-right squeezed against the
 * header — a minimized bottom-left bell with an on-demand popup is cleaner.
 */

const LED: Record<ToastKind, string> = {
  info: "var(--sema-info)",
  success: "var(--sema-success)",
  warning: "var(--sema-warning)",
  error: "var(--sema-error)",
};

function ToastRow({ toast, onDismiss }: { readonly toast: Toast; readonly onDismiss: () => void }) {
  const t = useI18n((s) => s.t);
  return (
    <div
      className="toast-card"
      data-testid="toast"
      data-kind={toast.kind}
      style={{ borderColor: "var(--glass-stroke)" }}
    >
      <span className="toast-led" aria-hidden="true" style={{ background: LED[toast.kind] }} />
      <div className="toast-body">
        <span className="toast-title">{toast.title}</span>
        {toast.message ? <span className="toast-message">{toast.message}</span> : null}
      </div>
      <button
        type="button"
        className="toast-dismiss"
        aria-label={t("app.toast.dismissAria")}
        data-testid="toast-dismiss"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}

export function ToastViewport() {
  const t = useI18n((s) => s.t);
  const toasts = useUi((s) => s.toasts);
  const dismissToast = useUi((s) => s.dismissToast);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Close the popover on outside click / Escape (no portal — positioned fixed).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="toast-bell" data-testid="toast-viewport" ref={rootRef}>
      <button
        type="button"
        className={cn("toast-bell-button", open && "is-open")}
        aria-label={t("toast.bell.aria", { count: String(toasts.length) })}
        aria-expanded={open}
        data-testid="toast-bell"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="bell" size={16} />
        {toasts.length > 0 ? (
          <span
            className={cn(
              "toast-bell-badge",
              toasts.some((x) => x.kind === "error") && "has-error",
            )}
            data-testid="toast-bell-count"
          >
            {toasts.length > 9 ? "9+" : toasts.length}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className={cn("toast-popover", toasts.length === 0 && "empty")}
          aria-live="polite"
          aria-atomic="false"
        >
          {toasts.length === 0 ? (
            <div className="toast-popover-empty" data-testid="toast-empty">
              <Icon name="check" size={14} />
              <span>{t("toast.bell.empty")}</span>
            </div>
          ) : (
            <>
              <div className="toast-popover-head">
                <span className="toast-popover-title">{t("toast.bell.title")}</span>
                <button
                  type="button"
                  className="toast-clear"
                  data-testid="toast-clear-all"
                  onClick={() => {
                    for (const toast of [...toasts]) dismissToast(toast.id);
                  }}
                >
                  {t("toast.bell.clear")}
                </button>
              </div>
              <div className="toast-popover-list">
                {toasts.map((toast) => (
                  <ToastRow key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
