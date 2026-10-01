import { useUi, type Toast, type ToastKind } from "@/state/ui";
import { useI18n } from "@/state/i18n";
import { cn } from "@/lib/utils";

/**
 * Toast bus renderer (S9.1-005). Top-right stacked, glass fill-3/blur-3,
 * semantic LED dot, dismiss button. Pure DOM — no portal needed (renders at
 * app root level in App).
 */

const LED: Record<ToastKind, string> = {
  info: "var(--sema-info)",
  success: "var(--sema-success)",
  warning: "var(--sema-warning)",
  error: "var(--sema-error)",
};

function ToastView({
  toast,
  onDismiss,
}: {
  readonly toast: Toast;
  readonly onDismiss: () => void;
}) {
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
  const toasts = useUi((s) => s.toasts);
  const dismissToast = useUi((s) => s.dismissToast);
  return (
    <div
      className={cn("toast-viewport", toasts.length === 0 && "empty")}
      data-testid="toast-viewport"
      aria-live="polite"
      aria-atomic="false"
    >
      {toasts.map((t) => (
        <ToastView key={t.id} toast={t} onDismiss={() => dismissToast(t.id)} />
      ))}
    </div>
  );
}
