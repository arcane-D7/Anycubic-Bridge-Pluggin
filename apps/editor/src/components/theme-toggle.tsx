import { useTheme, type ThemeChoice } from "@/state/theme";
import { useI18n } from "@/state/i18n";
import type { MsgKey } from "@/state/i18n-core";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

/**
 * Theme toggle (S9.1-002/005). Cycles light/dark/system via shadcn
 * DropdownMenu. `data-theme` on <html> is set imperatively — all colors are
 * CSS var-driven so the swap needs no re-render.
 */

const CHOICES: ReadonlyArray<{ value: ThemeChoice; labelKey: MsgKey }> = [
  { value: "light", labelKey: "theme.option.light" },
  { value: "dark", labelKey: "theme.option.dark" },
  { value: "system", labelKey: "theme.option.system" },
];

export function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const t = useI18n((s) => s.t);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("theme.trigger.aria")}
          data-testid="theme-toggle"
          title={t("theme.trigger.title")}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            aria-hidden="true"
          >
            {choice === "dark" ? (
              <path
                d="M13.5 9.7A5.5 5.5 0 1 1 6.3 2.5a4.6 4.6 0 0 0 7.2 7.2z"
                strokeLinejoin="round"
              />
            ) : (
              <>
                <circle cx="8" cy="8" r="3.4" />
                <path
                  d="M8 1.5v1.4M8 13.1v1.4M1.5 8h1.4M13.1 8h1.4M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"
                  strokeLinecap="round"
                />
              </>
            )}
          </svg>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="theme-menu">
        <DropdownMenuLabel>{t("theme.menu.label")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {CHOICES.map((c) => (
          <DropdownMenuItem
            key={c.value}
            data-testid={`theme-${c.value}`}
            onSelect={() => setChoice(c.value)}
          >
            {t(c.labelKey)}
            {choice === c.value ? " ✓" : ""}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
