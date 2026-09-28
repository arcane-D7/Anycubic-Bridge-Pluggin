/**
 * Expansion tools — Batch 0 (N1–N11 + N6), live-confirmed by
 * scripts/expansion-probe.mjs (2026-09-11), READ-ONLY by construction.
 *
 * These tools exercise cloud account/printer endpoints that were previously
 * listed in the catalogs (evidence: reference) or proven reachable only via
 * `expansion-probe.mjs`:
 *   N4  printer_status_snapshot   /work/printer/printersStatus (lifetime + slots)
 *   N1  account_print_history     /v2/project/printHistory (+ detail)
 *   N1  account_print_metrics     aggregates on top of printHistory
 *   N2  account_cloud_store       /work/index/getUserStore (quota preflight)
 *   N3  printer_lifetime_metrics  lifetime metrics extracted from printersStatus
 *   N5  account_cloud_files       /work/index/userFiles (cloud shelf listing)
 *   N6  printer_error_list        /v3/work_project/getErrorList + incident codes
 *   N11 printer_file_preview      /work/index/getModelFileInfo or gcode infoFdm
 *   (catalog) printer_order_registry  offline map of every known order id
 *
 * Every tool is GET/read-only. No motion, heat, feed, upload, delete or job
 * control is performed. All output passes through `redact()`.
 */
import { redact } from "./cloud-readonly-diagnostics.mjs";
import { ORDER, findSlicerJwt } from "./anycubic-cloud.mjs";

const EP = Object.freeze({
  getUserStore: "/work/index/getUserStore",
  printHistory: "/v2/project/printHistory",
  printHistoryDetail: "/v5/project/printHistory/detail",
  printersStatus: "/work/printer/printersStatus",
  userFiles: "/work/index/userFiles",
  getErrorList: "/v3/work_project/getErrorList",
  gcodeInfoFdm: "/work/gcode/infoFdm",
  getModelFileInfo: "/work/index/getModelFileInfo",
  getProjects: "/work/project/getProjects",
});

/** print_status int -> human label (observed values + reference vocabulary). */
const PRINT_STATUS = Object.freeze({
  0: "created/queued",
  1: "preparing",
  2: "success/finished",
  3: "failed",
  4: "cancelled/stopped",
  5: "paused",
  6: "printing",
  13: "resumed",
});

/** Failure reason vocabulary observed or documented on the platform. */
const FAILURE_REASONS = Object.freeze({
  10101: "Print task already exists (residual task on the printer)",
  10115: "Cannot parse the print task",
  10116: "Abnormal slice file; reslice and print with correct parameters",
  10133: "Missing commands in the gcode",
  10134: "Camera required for this print configuration",
  10135: "USB device required",
  10136: "Camera and USB device required",
  10137: "USB free space below 800M",
  10402: "Filament broken",
  10403: "Filament broken (secondary)",
  11503: "ACE connection error",
  11505: "Dryer target temperature not reached",
  11509: "ACE timeout",
  11511: "Extrusion abnormal",
  11512: "Retraction abnormal",
  11513: "ACE timeout (secondary)",
  11517: "ACE connection error (secondary)",
  11518: "Filament clogging",
  11519: "Filament tangle",
  11520: "Out of material",
  11521: "Color engine motor abnormal",
  11524: "ACE connection error (tertiary)",
  11529: "ACE NTC abnormal",
  11530: "ACE PTC abnormal",
  11531: "More than 8 colors cannot print",
  11538: "Cutter signal error",
  11801: 'Detected messy printing "offried noodles", task paused (AI spaghetti detection)',
  200: "normal finish",
  500: "internal error",
});

/**
 * Reverse lookup for report reasons: the printHistory API returns descriptive
 * text ("The printer cannot parse the file") instead of the numeric code.
 * These are the exact strings observed live on the platform (2026-09-11).
 */
const REASON_TEXT_TO_CODE = Object.freeze({
  "print task already exists": 10101,
  "the printer cannot parse the file": 10115,
  "abnormal slice file. please reslice and print with the correct parameters and software.": 10116,
  "missing commands in the gcode": 10133,
  "camera required for this print configuration": 10134,
  "usb device required": 10135,
  "camera and usb device required": 10136,
  "usb free space below 800m": 10137,
  "filament broken": 10402,
  "filament broken (secondary)": 10403,
  "ace connection error": 11503,
  "dryer target temperature not reached": 11505,
  "ace timeout": 11509,
  "extrusion abnormal": 11511,
  "retraction abnormal": 11512,
  "ace timeout (secondary)": 11513,
  "ace connection error (secondary)": 11517,
  "filament clogging": 11518,
  "filament tangle": 11519,
  "out of material": 11520,
  "color engine motor abnormal": 11521,
  "ace connection error (tertiary)": 11524,
  "ace ntc abnormal": 11529,
  "ace ptc abnormal": 11530,
  "more than 8 colors cannot print": 11531,
  "cutter signal error": 11538,
  'detected messy printing "offried noodles", task paused (ai spaghetti detection)': 11801,
});

const LIFETIME_FIELDS = Object.freeze([
  "print_count",
  "material_used",
  "material_gram_used",
  "print_totaltime",
  "machine_mac",
  "video_taskid",
  "is_clean_plate",
  "selected_time",
  "parameter.curr_nozzle_temp",
  "parameter.curr_hotbed_temp",
]);

/** The count of `---` placeholders in this source is incidental; not a marker. */

/** Parse a numeric value defensively (return null on garbage). */
export function num(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const match = String(value).match(/^([-+]?\d*\.?\d+)/);
    if (!match) return null;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Canonical human label for a failure reason: numeric code -> vocabulary label,
 * descriptive string -> reverse-matched code, anything else -> "code_<raw>".
 */
export function failureReasonLabel(reason) {
  if (typeof reason === "number") return FAILURE_REASONS[reason] ?? `code_${reason}`;
  if (typeof reason === "string") {
    const trimmed = reason.trim().toLowerCase();
    if (trimmed === "") return "unknown";
    const code = REASON_TEXT_TO_CODE[trimmed];
    if (code !== undefined && code !== null) return FAILURE_REASONS[code];
    return reason;
  }
  return "unknown";
}

/** Parse a slice JSON payload (the cloud stores it as a JSON string). */
export function parseJsonField(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

/** Canonical printer snapshot: walk a printersStatus entry to stable fields. */
export function mapPrinterStatusEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const machine = entry.machine_data ?? {};
  const version = entry.version ?? {};
  const parameter = entry.parameter ?? {};
  const slots = Array.isArray(entry.multi_color_box)
    ? entry.multi_color_box.map((box) => ({
        id: box?.id ?? 0,
        model_id: box?.model_id ?? 0,
        loaded_slot: box?.loaded_slot ?? -1,
        auto_feed: box?.auto_feed ?? 0,
        humidity: box?.humidity ?? null,
        drying_status: box?.drying_status ?? null,
        feed_status: box?.feed_status ?? null,
        slots: Array.isArray(box?.slots)
          ? box.slots.map((slot) => ({
              index: slot?.index ?? -1,
              status: slot?.status ?? -1,
              edit_status: slot?.edit_status ?? 0,
              type: slot?.type ?? null,
              sku: slot?.sku ?? null,
              color: slot?.color ?? null,
              color_group: slot?.color_group ?? null,
              consumables_percent: slot?.consumables_percent ?? null,
            }))
          : [],
      }))
    : [];
  return {
    printer_id: entry.id ?? null,
    name: entry.name ?? entry.model ?? null,
    model: entry.model ?? null,
    type: entry.type ?? null,
    machine_type: entry.machine_type ?? null,
    status: entry.status ?? null,
    ready_status: entry.ready_status ?? null,
    device_status: entry.device_status ?? null,
    is_printing: entry.is_printing ?? 0,
    is_clean_plate: entry.is_clean_plate ?? 0,
    available: entry.available ?? null,
    current: {
      nozzle_temp_c: parameter.curr_nozzle_temp ?? null,
      hotbed_temp_c: parameter.curr_hotbed_temp ?? null,
    },
    firmware: version.firmware_version ?? null,
    firmware_need_update: version.need_update ?? null,
    machine: {
      size_mm: [machine.size_x, machine.size_y, machine.size_z].every((v) => v != null)
        ? [machine.size_x, machine.size_y, machine.size_z]
        : null,
      resolution: [machine.res_x, machine.res_y]?.filter((v) => v != null).length
        ? [machine.res_x, machine.res_y]
        : null,
      pixel_density: machine.pixel ?? null,
      file_format: machine.suffix ?? null,
    },
    lifetime: {
      print_count: num(entry.print_count) ?? 0,
      material_used_kg: num(entry.material_used),
      material_gram_used: num(entry.material_gram_used) ?? 0,
      print_totaltime: entry.print_totaltime ?? null,
      print_totaltime_hours: parseDurationHours(entry.print_totaltime),
      machine_mac: entry.machine_mac ?? null,
      video_taskid: num(entry.video_taskid) ?? 0,
    },
    features: Array.isArray(entry.features)
      ? entry.features.map((feature) => ({
          name: feature?.name ?? null,
          value: feature?.value ?? null,
        }))
      : [],
    multi_color_box: slots,
  };
}

/** Parse "129hour35min" / "1h 13min" / "2h 32m 25s" into decimal hours. */
export function parseDurationHours(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const hours = value.match(/(\d+)\s*h/);
  const minutes = value.match(/(\d+)\s*m/i);
  const seconds = value.match(/(\d+)\s*s/i);
  if (!hours && !minutes && !seconds) return null;
  return (
    (hours ? Number(hours[1]) : 0) +
    (minutes ? Number(minutes[1]) / 60 : 0) +
    (seconds ? Number(seconds[1]) / 3600 : 0)
  );
}

/** Helper to run a GET and return the raw `data` payload through redact. */
async function getData(cloud, path, query = {}) {
  const response = await cloud.rawApi("GET", path, { query });
  return redact(response?.data ?? response);
}

/** Full printer status snapshot (N4). */
export async function collectPrinterStatusSnapshot(cloud, { printerId } = {}) {
  const entries = await getData(cloud, EP.printersStatus);
  const list = Array.isArray(entries) ? entries : Array.isArray(entries?.list) ? entries.list : [];
  const mapped = list.map(mapPrinterStatusEntry).filter(Boolean);
  // printersStatus omits the ACE shelf; getPrinters carries multi_color_box with
  // full slot data (sku, edit_status, consumables_percent, color_group). Merge it
  // so the snapshot is a single source of truth without an extra tool call.
  try {
    const printers = await cloud.rawApi("GET", "/work/printer/getPrinters", { query: {} });
    const printList = redact(printers?.data ?? []);
    for (const entry of mapped) {
      const full = printList.find((p) => Number(p?.id) === entry.printer_id);
      if (full?.multi_color_box) {
        entry.multi_color_box = Array.isArray(full.multi_color_box)
          ? full.multi_color_box.map((box) => ({
              id: box?.id ?? 0,
              model_id: box?.model_id ?? 0,
              loaded_slot: box?.loaded_slot ?? -1,
              auto_feed: box?.auto_feed ?? 0,
              humidity: box?.humidity ?? null,
              drying_status: box?.drying_status ?? null,
              feed_status: box?.feed_status ?? null,
              slots: Array.isArray(box?.slots)
                ? box.slots.map((slot) => ({
                    index: slot?.index ?? -1,
                    status: slot?.status ?? -1,
                    edit_status: slot?.edit_status ?? 0,
                    type: slot?.type ?? null,
                    sku: slot?.sku ?? null,
                    color: slot?.color ?? null,
                    color_group: slot?.color_group ?? null,
                    consumables_percent: slot?.consumables_percent ?? null,
                  }))
                : [],
            }))
          : [];
      }
      if (full?.features) entry.features = full.features;
    }
  } catch {
    /* keep printersStatus-only view when getPrinters is unavailable */
  }
  const selected =
    printerId === undefined
      ? (mapped[0] ?? null)
      : (mapped.find((p) => p.printer_id === Number(printerId)) ?? null);
  return {
    printer_id: selected?.printer_id ?? null,
    selected,
    printers: mapped,
    count: mapped.length,
    read_only: true,
    note: "Snapshot of /work/printer/printersStatus + /work/printer/getPrinters (ACE slots). lifetime + slots + features are aggregated; individual values are the printer-reported ones.",
  };
}

/** Print history listing + optional detail per task (N1). */
export async function collectPrintHistory(
  cloud,
  { printerId, page = 1, limit = 20, printStatus } = {},
) {
  const query = { page, limit };
  if (printStatus !== undefined) query.print_status = printStatus;
  if (printerId !== undefined) query.printer_id = printerId;
  const response = await cloud.rawApi("GET", EP.printHistory, { query });
  const raw = redact(response?.data ?? {});
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : [];
  const pageData = raw?.pageData ?? {};
  const prominent = list.slice(0, 3).map((item) => ({
    task_id: item?.task_id ?? null,
    gcode_name: item?.gcode_name ?? null,
    printer_name: item?.printer_name ?? null,
    create_time: item?.create_time ?? null,
    end_time: item?.end_time ?? null,
    print_status: item?.print_status ?? null,
    status_label: PRINT_STATUS[item?.print_status] ?? null,
    reason: item?.reason ?? null,
    reason_label: FAILURE_REASONS[item?.reason] ?? item?.reason ?? null,
  }));
  return {
    page: pageData.page ?? page,
    page_count: pageData.page_count ?? 1,
    total: pageData.total ?? list.length,
    entries: list,
    recent: prominent,
    read_only: true,
  };
}

/** Print history detail for a single task (N1 detail). */
export async function collectPrintHistoryDetail(cloud, { taskId }) {
  const response = await cloud.rawApi("GET", EP.printHistoryDetail, { query: { task_id: taskId } });
  return { task_id: taskId, data: redact(response?.data ?? response), read_only: true };
}

/**
 * Aggregate print history into cost/failure metrics (N1 metrics).
 * Purely derived from the same endpoint as collectPrintHistory; no extra calls.
 */
export async function collectPrintMetrics(cloud, { printerId, limit = 100, printStatus } = {}) {
  const history = await collectPrintHistory(cloud, { printerId, limit, printStatus });
  const outcomes = {
    total: history.total,
    finished: 0,
    failed: 0,
    cancelled: 0,
    paused: 0,
    other: 0,
  };
  const failures = {};
  const records = history.entries ?? [];
  for (const entry of records) {
    const status = entry.print_status ?? null;
    if (status === 2) outcomes.finished += 1;
    else if (status === 3) {
      outcomes.failed += 1;
      const label = failureReasonLabel(entry.reason);
      failures[label] = (failures[label] ?? 0) + 1;
    } else if (status === 4) outcomes.cancelled += 1;
    else if (status === 5) outcomes.paused += 1;
    else outcomes.other += 1;
  }
  const totalFailed = Object.values(failures).reduce((a, b) => a + b, 0);
  return {
    printer_id: printerId ?? null,
    read_only: true,
    window: { limit, status_filter: printStatus ?? null },
    outcomes,
    failure_breakdown: failures,
    failure_rate_pct:
      outcomes.total > 0 ? Number(((totalFailed / outcomes.total) * 100).toFixed(2)) : null,
    success_rate_pct:
      outcomes.total > 0 ? Number(((outcomes.finished / outcomes.total) * 100).toFixed(2)) : null,
  };
}

/** Lifetime metrics without the full snapshot (N3). */
export async function collectLifetimeMetrics(cloud, { printerId } = {}) {
  const snapshot = await collectPrinterStatusSnapshot(cloud, { printerId });
  const selected = snapshot.selected;
  if (!selected) throw new Error("No printer data to compute lifetime metrics");
  return {
    printer_id: selected.printer_id,
    read_only: true,
    lifetime: selected.lifetime,
    current: selected.current,
    firmware: selected.firmware,
    machine_mac: selected.lifetime.machine_mac,
    video_taskid: selected.lifetime.video_taskid,
    features: selected.features,
    sources: [{ id: "printers_status", evidence: "live" }],
  };
}

/** Cloud storage quota (N2). */
export async function collectCloudStore(cloud) {
  const data = await getData(cloud, EP.getUserStore);
  return {
    read_only: true,
    used_bytes: data?.used_bytes ?? null,
    total_bytes: data?.total_bytes ?? null,
    used: data?.used ?? null,
    total: data?.total ?? null,
    user_file_exists: data?.user_file_exists ?? null,
    units_note: "Bytes are authoritative; used/total strings are human labels.",
  };
}

/** Cloud projects listing (N8 extension: getProjects was confirmed in the probe). */
export async function collectCloudProjects(cloud, { printerId } = {}) {
  const query = printerId !== undefined ? { printer_id: printerId } : {};
  const data = await getData(cloud, EP.getProjects, query);
  const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : [];
  const projected = list.map((project) => ({
    id: project?.id ?? null,
    name: project?.name ?? null,
    model_name: project?.model_name ?? null,
    thumbnail: project?.thumbnail ?? null,
    number: project?.number ?? null,
    size: project?.size ?? null,
    create_time: project?.create_time ?? null,
    update_time: project?.update_time ?? null,
    machine_name: project?.machine_name ?? null,
    status: project?.status ?? null,
  }));
  return { count: projected.length, projects: projected, read_only: true };
}

/** Lifetime/consumption metrics in Prometheus/OpenMetrics text format (N15). */
export function collectMetricsExpose(snapshot, { printerId } = {}) {
  const selected = snapshot?.selected ?? snapshot?.printers?.[0] ?? null;
  if (!selected) {
    return {
      printer_id: printerId ?? null,
      read_only: true,
      metrics_present: false,
      note: "No printer snapshot available to expose metrics.",
    };
  }
  const lifetime = selected.lifetime ?? {};
  const current = selected.current ?? {};
  const slots = Array.isArray(selected.multi_color_box)
    ? selected.multi_color_box.flatMap((box) => (Array.isArray(box?.slots) ? box.slots : []))
    : [];
  const lines = [];
  lines.push("# HELP printer_print_count_total Total number of prints started on this printer.");
  lines.push("# TYPE printer_print_count_total counter");
  lines.push(
    `printer_print_count_total{printer_id="${selected.printer_id}"} ${lifetime.print_count ?? 0}`,
  );
  lines.push("# HELP printer_material_used_kg Total filament used in kilograms.");
  lines.push("# TYPE printer_material_used_kg gauge");
  lines.push(
    `printer_material_used_kg{printer_id="${selected.printer_id}"} ${lifetime.material_used_kg ?? 0}`,
  );
  lines.push("# HELP printer_print_totaltime_hours Total print time in hours.");
  lines.push("# TYPE printer_print_totaltime_hours counter");
  lines.push(
    `printer_print_totaltime_hours{printer_id="${selected.printer_id}"} ${lifetime.print_totaltime_hours ?? 0}`,
  );
  lines.push("# HELP printer_temperature_c Current temperature in Celsius.");
  lines.push("# TYPE printer_temperature_c gauge");
  if (current.nozzle_temp_c != null)
    lines.push(
      `printer_temperature_c{printer_id="${selected.printer_id}",sensor="nozzle"} ${current.nozzle_temp_c}`,
    );
  if (current.hotbed_temp_c != null)
    lines.push(
      `printer_temperature_c{printer_id="${selected.printer_id}",sensor="hotbed"} ${current.hotbed_temp_c}`,
    );
  for (const slot of slots) {
    const consumables = slot.consumables_percent;
    if (consumables == null) continue;
    lines.push(
      `printer_consumables_percent{printer_id="${selected.printer_id}",slot="${slot.slot_index ?? slot.index ?? "?"}"} ${consumables}`,
    );
  }
  lines.push(
    "# HELP printer_ace_drying_status Drying status per ACE box (0 = idle, 1 = drying; remain_time in seconds).",
  );
  lines.push("# TYPE printer_ace_drying_status gauge");
  if (Array.isArray(selected.multi_color_box)) {
    selected.multi_color_box.forEach((box, i) => {
      const drying = box?.drying_status ?? null;
      const active =
        drying && typeof drying === "object" ? Number(drying.isDrying ?? drying.drying ?? 0) : 0;
      const remain = drying && typeof drying === "object" ? Number(drying.remain_time ?? 0) : 0;
      lines.push(
        `printer_ace_drying_status{printer_id="${selected.printer_id}",box="${i}"} ${Number.isFinite(active) ? active : 0}`,
      );
      if (Number.isFinite(remain) && remain > 0) {
        lines.push(
          `printer_ace_drying_remain_seconds{printer_id="${selected.printer_id}",box="${i}"} ${remain}`,
        );
      }
    });
  }
  return {
    printer_id: selected.printer_id,
    read_only: true,
    metrics_present: true,
    format: "prometheus_text_0_0_4",
    text: lines.join("\n"),
  };
}

/** Cloud shelf file listing (N5) + projection for previews. */
export async function collectCloudFiles(cloud, { fileType } = {}) {
  const data = await getData(cloud, EP.userFiles);
  const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : [];
  const filtered = fileType === undefined ? list : list.filter((f) => f.file_type === fileType);
  const projected = filtered.map((file) => ({
    id: file?.id ?? null,
    gcode_id: file?.gcode_id ?? null,
    file_type: file?.file_type ?? null,
    file_extension: file?.file_extension ?? null,
    old_filename: file?.old_filename ?? null,
    machine_name: file?.machine_name ?? null,
    machine_type: file?.machine_type ?? null,
    size: file?.size ?? null,
    create_time: file?.create_time ?? null,
    is_parse: file?.is_parse ?? 0,
    img_status: file?.img_status ?? 0,
    has_thumbnail: Boolean(file?.thumbnail),
    thumbnail: file?.thumbnail ?? null,
    md5: file?.md5 ?? null,
    path: file?.path ?? null,
    region: file?.region ?? null,
    status: file?.status ?? null,
  }));
  return { count: filtered.length, files: projected, read_only: true };
}

/** Error list + failure reason vocabulary (N6). */
export async function collectErrorList(cloud, { printerId } = {}) {
  const query = printerId !== undefined ? { id: printerId } : {};
  const data = await getData(cloud, EP.getErrorList, query);
  const list = Array.isArray(data) ? data : [];
  return {
    printer_id: printerId ?? null,
    read_only: true,
    errors: list,
    failure_reason_codes: FAILURE_REASONS,
    note: "getErrorList returns camera/AI inspection defect categories; failure_reason_codes maps task reason ints to incident labels.",
  };
}

/** Preview a cloud file via slice info (N11). */
export async function collectFilePreview(cloud, { gcodeId, fileId } = {}) {
  if (gcodeId === undefined && fileId === undefined)
    throw new Error("gcode_id or file_id is required for printer_file_preview");
  const query = {};
  if (gcodeId !== undefined) query.id = gcodeId;
  if (fileId !== undefined) query.id = fileId;
  const path = gcodeId !== undefined ? EP.gcodeInfoFdm : EP.getModelFileInfo;
  const response = await cloud.rawApi("GET", path, { query });
  const data = redact(response?.data ?? response);
  const sliceParam = parseJsonField(data?.slice_param);
  const sliceResult = parseJsonField(data?.slice_result);
  const paintInfos = Array.isArray(sliceParam?.paint_infos) ? sliceParam.paint_infos : [];
  return {
    read_only: true,
    gcode_id: gcodeId ?? null,
    file_id: fileId ?? null,
    name: data?.name ?? data?.old_filename ?? null,
    status: data?.status ?? null,
    size: data?.size ?? null,
    md5: sliceResult?.sliced_md5 ?? data?.md5 ?? null,
    full: data,
    slice_param: sliceParam,
    slice_result: sliceResult,
    layers: sliceResult?.total_layers ?? data?.total_layers ?? null,
    dimensions: {
      x: sliceResult?.size_x ?? null,
      y: sliceResult?.size_y ?? null,
      z: sliceResult?.size_z ?? null,
    },
    print_time_h: sliceResult?.print_time ?? null,
    used_filament_g: sliceResult?.used_filament ?? null,
    filament_per_extruder_g: Array.isArray(sliceResult?.["filament used [g]"])
      ? sliceResult["filament used [g]"]
      : null,
    per_color: paintInfos.map((info) => ({
      paint_index: info?.paint_index ?? null,
      material_type: info?.material_type ?? null,
      color: info?.paint_color ?? null,
      filament_used_g: num(info?.filament_used) ?? null,
    })),
  };
}

/** Offline order-id registry (catalog, read-only). */
export function orderRegistry() {
  return {
    read_only: true,
    note: "Order ids are descriptive; only the validated ones are marked evidence:live. Never infer device semantics from an unvalidated id.",
    validated_live: {
      START_PRINT: ORDER.START_PRINT,
      PAUSE_PRINT: ORDER.PAUSE_PRINT,
      RESUME_PRINT: ORDER.RESUME_PRINT,
      STOP_PRINT: ORDER.STOP_PRINT,
      MULTI_COLOR_BOX_GET_INFO: ORDER.MULTI_COLOR_BOX_GET_INFO,
      QUERY_PERIPHERALS: ORDER.QUERY_PERIPHERALS,
      GET_LIGHT_STATUS: ORDER.GET_LIGHT_STATUS,
      QUERY_AXIS_POSITION: ORDER.QUERY_AXIS_POSITION,
      LOCAL_FILES: 103,
      USB_FILES: 101,
    },
    from_reference_AnycubicOrderID_IntEnum: {
      START_PRINT: 1,
      PAUSE: 2,
      RESUME: 3,
      STOP: 4,
      PRINT_SETTINGS: 6,
      STOP_PRINT_FORCE: 44,
      LIST_UDISK_FILES: 101,
      DELETE_UDISK_FILE: 102,
      LIST_LOCAL_FILES: 103,
      DELETE_LOCAL_FILE: 104,
      MOVE_AXLE: 201,
      MOVE_AXLE_TO_COORDINATES: 202,
      START_EXPOSURE: 301,
      CANCEL_EXPOSURE: 302,
      RESIDUAL: 501,
      SELF_TEST: 601,
      CANCEL_SELF_TEST: 602,
      AUTO_OPERATION: 701,
      CANCEL_AUTO_OPERATION: 702,
      RELEASE_FILM: 801,
      GET_RELEASE_FILM: 802,
      SET_PRINT_STATUS_FREE: 901,
      CAMERA_OPEN: 1001,
      CAMERA_CLOSE: 1002,
      MULTI_COLOR_BOX_GET_INFO: 1206,
      MULTI_COLOR_BOX_DRY: 1207,
      FEED_FILAMENT: 1208,
      FEED_FILAMENT_FINISH: 1209,
      MULTI_COLOR_BOX_REFRESH_SLOT: 1210,
      MULTI_COLOR_BOX_SET_SLOT: 1211,
      MULTI_COLOR_BOX_AUTO_FEED: 1212,
      GET_M7_AUTO_OPERATION: 1228,
      EXTFILBOX: 1229,
      GET_EXTFILBOX_INFO: 1230,
      QUERY_PERIPHERALS: 1231,
      GET_LIGHT_STATUS: 1232,
      SET_LIGHT_STATUS: 1233,
      SET_TEMPERATURE: 1214,
      SET_FAN_SPEED: 1215,
      SET_PRINT_SPEED: 1216,
    },
    failure_reasons: FAILURE_REASONS,
    print_status_labels: PRINT_STATUS,
  };
}

export function registerExpansionTools(server, z, { manager, resolvePrinter } = {}) {
  const shared = {
    printer_id: z.number().int().positive().optional(),
    access_token: z.string().max(4096).optional(),
    resources_dir: z.string().max(1024).optional(),
  };

  async function ensureSession(args) {
    const cloud = manager?.cloud;
    if (!cloud) throw new Error("No cloud session available.");
    if (!cloud.xxToken) {
      const token =
        args.access_token ??
        process.env.ANYCUBIC_CLOUD_TOKEN ??
        findSlicerJwt(process.env.APPDATA ? `${process.env.APPDATA}/AnycubicSlicerNext/log` : "") ??
        null;
      if (token && !cloud.access_token) cloud.access_token = token;
      await cloud.login();
    }
    return cloud;
  }

  async function resolvePrinterOrDefault(cloud, printerId) {
    if (resolvePrinter) return resolvePrinter(cloud, printerId);
    const printers = await cloud.listPrinters();
    const printer =
      printerId === undefined ? printers[0] : printers.find((p) => Number(p.id) === printerId);
    if (!printer)
      throw new Error(
        printerId === undefined
          ? "No printer bound to this account"
          : "Requested printer is not bound to this account",
      );
    return printer;
  }

  const tool = (name, description, additional, handler) =>
    server.registerTool(
      name,
      {
        title: description.title,
        description: description.text,
        inputSchema: {
          ...shared,
          ...additional,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args) => {
        try {
          const data = await handler(args);
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
          };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
        }
      },
    );

  tool(
    "printer_status_snapshot",
    {
      title: "Printer status snapshot (lifetime + slots + features)",
      text: "Read-only. Returns the full /work/printer/printersStatus snapshot for every printer bound to the account, including lifetime counters (print_count, material_used, print_totaltime), current temperatures, firmware, machine geometry, feature flags and every ACE slot. No motion, heat, feed, upload, delete or job control is performed.",
    },
    {},
    async (args) => {
      const cloud = await ensureSession(args);
      return collectPrinterStatusSnapshot(cloud, { printerId: args.printer_id });
    },
  );

  tool(
    "account_print_history",
    {
      title: "Print history (projects)",
      text: "Read-only. Lists the cloud print history (page/limit/status filter) and, when include_detail is set, fetches the per-task detail (v5/project/printHistory/detail). Each entry carries print_status, reason and a human-readable failure label for incidents. Never mutates anything.",
    },
    {
      page: z.number().int().positive().default(1),
      limit: z.number().int().min(1).max(100).default(20),
      print_status: z.number().int().optional(),
      include_detail: z.boolean().default(false),
    },
    async (args) => {
      const cloud = await ensureSession(args);
      const list = await collectPrintHistory(cloud, {
        printerId: args.printer_id,
        page: args.page,
        limit: args.limit,
        printStatus: args.print_status,
      });
      if (!args.include_detail) return list;
      const details = {};
      for (const entry of list.entries.slice(0, 3)) {
        try {
          details[entry.task_id] = await collectPrintHistoryDetail(cloud, {
            taskId: entry.task_id,
          });
        } catch (error) {
          details[entry.task_id] = { state: "error", error: redact(error.message) };
        }
      }
      return { ...list, details };
    },
  );

  tool(
    "printer_lifetime_metrics",
    {
      title: "Printer lifetime metrics",
      text: "Read-only. Aggregates the lifetime counters from /work/printer/printersStatus into a compact view: print_count, material_used (kg), material_gram_used, print_totaltime (hours + raw label), machine_mac, video_taskid, current temperatures, firmware and capabilities. Ideal for dashboards and preventive maintenance.",
    },
    {},
    async (args) => {
      const cloud = await ensureSession(args);
      return collectLifetimeMetrics(cloud, { printerId: args.printer_id });
    },
  );

  tool(
    "account_cloud_store",
    {
      title: "Cloud storage quota",
      text: "Read-only. Returns the account cloud storage usage (/work/index/getUserStore): used_bytes, total_bytes, the human labels and user_file_exists, useful as a preflight before an upload. Never uploads or deletes anything.",
    },
    {},
    async (args) => {
      const cloud = await ensureSession(args);
      return collectCloudStore(cloud);
    },
  );

  tool(
    "account_cloud_projects",
    {
      title: "Cloud projects",
      text: "Read-only. Lists the account cloud projects (/work/project/getProjects, confirmed in the expansion probe): id, name, model, thumbnail, size and timestamps. Useful as a report/recovery index. Never uploads or deletes anything.",
    },
    {},
    async (args) => {
      const cloud = await ensureSession(args);
      return collectCloudProjects(cloud, { printerId: args.printer_id });
    },
  );

  tool(
    "account_print_metrics",
    {
      title: "Print history aggregate metrics (cost/failures)",
      text: "Read-only. Derives outcome counters (finished/failed/cancelled/paused), the failure breakdown by reason label and success/failure rates from the same printHistory endpoint used by account_print_history. No additional device calls; never mutates anything.",
    },
    {
      limit: z.number().int().min(1).max(100).default(100),
      print_status: z.number().int().optional(),
    },
    async (args) => {
      const cloud = await ensureSession(args);
      return collectPrintMetrics(cloud, {
        printerId: args.printer_id,
        limit: args.limit,
        printStatus: args.print_status,
      });
    },
  );

  tool(
    "printer_metrics_expose",
    {
      title: "Printer metrics in Prometheus/OpenMetrics text format",
      text: "Read-only. Renders the lifetime + temperature + consumables snapshot as Prometheus text (printer_print_count_total, printer_material_used_kg, printer_print_totaltime_hours, printer_temperature_c, printer_consumables_percent, printer_ace_drying_status) — ready to feed Grafana/scrape targets. No device calls beyond the status snapshot; never mutates anything.",
    },
    {},
    async (args) => {
      const cloud = await ensureSession(args);
      const snapshot = await collectPrinterStatusSnapshot(cloud, { printerId: args.printer_id });
      return collectMetricsExpose(snapshot, { printerId: args.printer_id });
    },
  );

  tool(
    "account_cloud_files",
    {
      title: "Cloud shelf files",
      text: "Read-only. Lists the account cloud files (/work/index/userFiles) with metadata (gcode_id, size, thumbnail, md5, path). Use it to find candidates for previews or start jobs. Never uploads or deletes anything.",
    },
    { file_type: z.number().int().optional() },
    async (args) => {
      const cloud = await ensureSession(args);
      return collectCloudFiles(cloud, { fileType: args.file_type });
    },
  );

  tool(
    "printer_error_list",
    {
      title: "Printer/AI error catalog + failure labels",
      text: "Read-only. Returns the platform error list (/v3/work_project/getErrorList — camera/AI defect categories) plus the mapped failure_reason_codes vocabulary that turns task reason ints (10101, 10115, 10116, 11520, 11801 spaghetti …) into human labels for incident analysis. Never mutates anything.",
    },
    {},
    async (args) => {
      const cloud = await ensureSession(args);
      return collectErrorList(cloud, { printerId: args.printer_id });
    },
  );

  tool(
    "printer_file_preview",
    {
      title: "Cloud file preview (slice metadata + per-color usage)",
      text: "Read-only. Resolves a cloud gcode (via /work/gcode/infoFdm) or file (via /work/index/getModelFileInfo) into slice metadata: total layers, dimensions, print time, used_filament and per-color filament consumption (paint_infos). Only reads; never uploads, downloads, or starts anything.",
    },
    {
      gcode_id: z.number().int().positive().optional(),
      file_id: z.number().int().positive().optional(),
    },
    async (args) => {
      if (args.gcode_id === undefined && args.file_id === undefined)
        throw new Error("gcode_id or file_id is required");
      const cloud = await ensureSession(args);
      return collectFilePreview(cloud, { gcodeId: args.gcode_id, fileId: args.file_id });
    },
  );

  tool(
    "printer_order_registry",
    {
      title: "Order-id registry (validated + reference)",
      text: "Read-only, offline. Maps every known HTTP order id: the live-validated subset (START_PRINT=1…STOP_PRINT=4, multi-color-box read, peripheries, light, axis, local/USB files) and the full reference IntEnum (STOP_PRINT_FORCE=44, SET_PRINT_STATUS_FREE=901, FEED_FILAMENT_FINISH=1209, camera 1001/1002, etc.) with the failure-reason and print-status vocabularies. It only describes; it sends nothing.",
    },
    {},
    async () => orderRegistry(),
  );
}
