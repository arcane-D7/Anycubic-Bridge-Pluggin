/**
 * P1-2 — shared printer env reader.
 *
 * The `ANYCUBIC_PRINTER_IPS` env value is read ONLY through this helper
 * (import.meta.env lives in the browser layer). Extracted from
 * `PrinterPicker` so the header picker and the Device panel share the exact
 * same discovery input. Never hardcoded — comes from the machine config.
 */
export function printerEnvRaw(): string {
  return (import.meta.env.ANYCUBIC_PRINTER_IPS as string | undefined) ?? "";
}
