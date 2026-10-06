import type { PrinterInfo, PrinterListResult, PrinterSnapshot } from "./types";

/**
 * S9.13-002 — Anycubic CLOUD printer lane (webview → loopback cloud-bridge).
 *
 * The editor discovers printers today ONLY via LAN (`ANYCUBIC_PRINTER_IPS` +
 * port probe). The preserved MCP server owns the full cloud stack
 * (`account_login`/`account_devices`/`account_cloud_diagnostics`, JWT in a
 * DPAPI TokenStore) but speaks stdio; `scripts/cloud-bridge.mjs` (S9.13-001)
 * exposes it on a loopback HTTP port with the same CORS/egress posture as the
 * Rust broker loopback (S9.6-008).
 *
 * THIS FILE is the browser-side counterpart of `chat-transport.ts`:
 *   - The loopback URL comes ONLY from env (`ANYCUBIC_CLOUD_LOOPBACK_URL`, no
 *     hardcoded port/IP literal) — check:architecture invariant.
 *   - The JWT never leaves the MCP child; the webview only sees the read-only
 *     `/printer/cloud/*` surface (login status, devices, diagnostics).
 *   - Pure URL/env helpers stay headless-testable under Node 24; the fetcher
 *     factories return typed results so the printer stores need no cloud
 *     knowledge.
 */

/** Pure env-value gate (headless): a non-blank value enables the cloud lane. */
export function cloudLaneConfiguredFrom(raw: string | undefined): boolean {
  return (raw ?? "").trim().length > 0;
}

/** Pure base-URL derivation; env is authority — never a literal. */
export function cloudBaseUrlFrom(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed;
}

/** True when the cloud lane is enabled by env (webview env read ONLY here). */
export function cloudLaneConfigured(): boolean {
  return cloudLaneConfiguredFrom(import.meta.env.ANYCUBIC_CLOUD_LOOPBACK_URL as string | undefined);
}

/** Resolve the cloud-bridge base URL from env (no literal). */
export function cloudBaseUrl(): string {
  return cloudBaseUrlFrom(
    (import.meta.env.ANYCUBIC_CLOUD_LOOPBACK_URL as string | undefined) ?? "",
  );
}

/** Region for cloud calls — env default (agnostic), never a real account value. */
export function cloudRegion(): string {
  return (import.meta.env.ANYCUBIC_CLOUD_REGION as string | undefined) ?? "en";
}

/** Default snapshot diagnostic kind — `printer_info` (full read-only info). */
export const defaultKind = "printer_info" as const;

/**
 * Discover the account's cloud printers via the loopback bridge.
 * Returns a `PrinterListResult` with `source: "cloud"` so the picker can
 * badge them; each `PrinterInfo` uses the cloud device `id` as the printer id
 * (stable account id — never an env-derived LAN id).
 */
export async function cloudDiscoverPrinters(base = cloudBaseUrl()): Promise<PrinterListResult> {
  const url = `${base}/printer/cloud/devices?region=${encodeURIComponent(cloudRegion())}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`cloud-bridge devices ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    ok?: boolean;
    devices?: ReadonlyArray<{
      id?: string;
      key?: string;
      machineType?: string | null;
      name?: string | null;
      model?: string | null;
      online?: boolean;
    }>;
  };
  if (data.ok === false) {
    throw new Error("cloud-bridge devices: not ok");
  }
  const devices = data.devices ?? [];
  return {
    ok: true,
    source: "cloud",
    printers: devices.map((device): PrinterInfo => ({
      id: `cloud-${device.id ?? ""}`,
      name: device.model ?? device.name ?? device.id ?? "Cloud printer",
      ip: device.key ?? device.id ?? "", // dev_key is the transport identity
      machineType: device.machineType ?? null,
      reachable: device.online ?? null,
      lastSeenAt: null,
    })),
  };
}

/** Cloud device + kind → `PrinterSnapshot` (schema v1, null-safe). */
export interface CloudSnapshotOptions {
  readonly printerId: string;
  readonly kind?: string;
}

/** Extract the numeric Anycubic printer id from a `cloud-<id>` editor id
 * (the picker prefixes cloud ids with `cloud-`; the bridge expects the raw
 * account id). Non-cloud ids are passed through for safety. */
export function cloudNumericId(printerId: string): string {
  return printerId.startsWith("cloud-") ? printerId.slice("cloud-".length) : printerId;
}

/**
 * Fetch a cloud printer snapshot via the loopback bridge
 * (`account_cloud_diagnostics`, read-only). The bridge returns a raw
 * diagnostic; the editor's pure `mapPrinterPayload` mapper (shared with the
 * LAN mock) normalizes the raw MCP-flat payload into the same
 * `PrinterSnapshot` schema, so the Device panel consumes ONE shape
 * regardless of source. `cloudPayloadToMcp` re-keys the CLOUD payload
 * (Anycubic cloud API shapes) into that MCP-flat grammar first.
 */
export async function cloudFetchSnapshot(
  options: CloudSnapshotOptions,
  base = cloudBaseUrl(),
): Promise<PrinterSnapshot> {
  const kind = options.kind ?? defaultKind;
  const numeric = cloudNumericId(options.printerId);
  const url =
    `${base}/printer/cloud/snapshot?printerId=${encodeURIComponent(numeric)}` +
    `&kind=${encodeURIComponent(kind)}&region=${encodeURIComponent(cloudRegion())}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error(`cloud-bridge snapshot ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    ok?: boolean;
    diagnostic?: { response?: unknown } | null;
  };
  if (data.ok === false || !data.diagnostic) {
    throw new Error("cloud-bridge snapshot: empty diagnostic");
  }
  // The bridge returns the raw Anycubic payload under `diagnostic.response`;
  // the pure mapper normalizes it into the universal snapshot shape.
  const { mapPrinterPayload } = await import("@/state/printer-path-map");
  const raw = data.diagnostic.response as Readonly<Record<string, unknown>> | null | undefined;
  const dataBlock = raw?.data as Readonly<Record<string, unknown>> | null | undefined;
  // Re-key the CLOUD payload into the MCP-flat grammar the mapper knows.
  const flat = cloudPayloadToMcp(dataBlock ?? {});
  return mapPrinterPayload(options.printerId, flat);
}

/**
 * Re-key an Anycubic CLOUD diagnostic payload (the `data` block of
 * `/v2/printer/info` etc.) into the MCP-flat paths `mapPrinterPayload`
 * understands (same grammar the LAN mock uses). Unknown keys fall through as
 * raw. Null-safe + agnostic — every read uses the `get` helper.
 */
export function cloudPayloadToMcp(
  p: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const get = (path: string): unknown => {
    let cur: unknown = p;
    for (const part of path.split(".")) {
      if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Readonly<Record<string, unknown>>)[part];
      if (cur === undefined) return undefined;
    }
    return cur;
  };
  const out: Record<string, unknown> = {};
  // identity
  if (get("version.firmware_version") !== undefined) {
    out["firmware_version"] = get("version.firmware_version");
  }
  if (get("machine_type") !== undefined) out["machine_type"] = get("machine_type");
  if (get("machine_data.name") !== undefined) {
    out["machine_data"] = {
      ...((out["machine_data"] as object | undefined) ?? {}),
      name: get("machine_data.name"),
    };
  }
  if (get("nozzle_diameter") !== undefined) out["nozzle_diameter_mm"] = get("nozzle_diameter");
  const sx = get("machine_data.size_x") as number | undefined;
  const sy = get("machine_data.size_y") as number | undefined;
  const sz = get("machine_data.size_z") as number | undefined;
  if (sx !== undefined || sy !== undefined || sz !== undefined) {
    out["machine_data"] = {
      ...((out["machine_data"] as object | undefined) ?? {}),
      size: { x: sx ?? null, y: sy ?? null, z: sz ?? null },
    };
  }
  // temps + print (the cloud `parameter.*` block is nested under `parameter`)
  const nozzleCur = get("parameter.curr_nozzle_temp") ?? get("curr_nozzle_temp");
  const nozzleTarget =
    get("parameter.target_nozzle_temp") ?? get("multi_color_box.target_nozzle_temp");
  if (nozzleCur !== undefined) out["nozzle_temp"] = nozzleCur;
  if (nozzleTarget !== undefined) out["target_nozzle"] = nozzleTarget;
  if (get("parameter.curr_hotbed_temp") !== undefined) {
    out["bed_temp"] = get("parameter.curr_hotbed_temp");
  }
  // print state: is_printing 1/0 → printing/idle; paused via print_status.
  const printing = get("is_printing");
  if (printing !== undefined) {
    out["print_state"] = Number(printing) === 1 ? "printing" : "idle";
  }
  // speed/percentage if the cloud exposes them
  const progress = get("parameter.progress") ?? get("progress");
  if (progress !== undefined) out["progress"] = progress;
  // peripherals
  if (get("multi_color_box") !== undefined) {
    out["peripherie.multiColorBox"] = get("multi_color_box");
    out["multiColorBox"] = get("multi_color_box");
  }
  // capabilities: features[] → {name: value} map (boolean-ish preserve).
  const features = get("features");
  if (Array.isArray(features)) {
    const cap: Record<string, unknown> = {};
    for (const f of features as ReadonlyArray<Readonly<Record<string, unknown>>>) {
      if (typeof f === "object" && f !== null) {
        const n = String(f["name"] ?? "");
        if (n) cap[n] = f["value"] ?? true;
      }
    }
    out["features"] = cap;
  }
  // ACE boxes from multi_color_box.slots
  const mcBox = get("multi_color_box") as Readonly<Record<string, unknown>> | null | undefined;
  if (mcBox && typeof mcBox === "object") {
    const rawSlots = Array.isArray(mcBox["slots"]) ? mcBox["slots"] : [];
    // Cloud slot grammar uses `status` for the filament state (`aceSlotFrom`
    // reads `property`/`state`) — re-key so the LAN mapper can name it.
    const slots = rawSlots.map((raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const r = raw as Readonly<Record<string, unknown>>;
      return { ...r, property: r["property"] ?? r["state"] ?? r["status"] };
    });
    // NOTE: the mapper navigates DOT PATHS, so the ACE array must be NESTED
    // (`out.ace.boxes`), not a literal-dotted key (`out["ace.boxes"]`).
    out["ace"] = {
      boxes: [
        {
          index: mcBox["id"] ?? 0,
          modelId: mcBox["model_id"] ?? null,
          slots,
          temp: get("multi_color_box.temp"),
          humidity: get("multi_color_box.humidity"),
          loaded_slot: get("multi_color_box.loaded_slot"),
          auto_feed: get("multi_color_box.auto_feed"),
          drying: get("multi_color_box.drying_status") ?? null,
        },
      ],
    };
  }
  return out;
}
