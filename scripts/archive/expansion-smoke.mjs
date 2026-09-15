// Smoke-test the expansion tools module directly against the live account
// (read-only). Exercises the same functions the MCP tools call.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import {
  collectPrinterStatusSnapshot,
  collectPrintHistory,
  collectPrintHistoryDetail,
  collectLifetimeMetrics,
  collectCloudStore,
  collectCloudFiles,
  collectErrorList,
  collectFilePreview,
  collectCloudProjects,
  collectPrintMetrics,
  collectMetricsExpose,
  orderRegistry,
} from "./printer-expansion-tools.mjs";
import {
  checkFirmwareUpdate,
  collectEventWatch,
  collectCameraCloudInfo,
} from "./printer-edge-tools.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();

const printerId = <PRINTER_ID>;
const summary = {};

// N4 status snapshot
const snapshot = await collectPrinterStatusSnapshot(cloud, { printerId });
summary.snapshot = {
  count: snapshot.count,
  selected_name: snapshot.selected?.name,
  print_count: snapshot.selected?.lifetime?.print_count,
  material_used: snapshot.selected?.lifetime?.material_used_kg,
  totaltime: snapshot.selected?.lifetime?.print_totaltime,
  video_taskid: snapshot.selected?.lifetime?.video_taskid,
  slots: snapshot.selected?.multi_color_box?.length,
};

// N1 history
const history = await collectPrintHistory(cloud, { printerId, page: 1, limit: 5 });
summary.history = {
  total: history.total,
  entries: history.entries.length,
  recent: history.recent?.map((r) => ({
    task: r.task_id,
    status: r.status_label,
    reason: r.reason_label,
  })),
};

// N2 store
const store = await collectCloudStore(cloud);
summary.store = { used: store.used, total: store.total, used_bytes: store.used_bytes };

// N3 lifetime
const lifetime = await collectLifetimeMetrics(cloud, { printerId });
summary.lifetime = { ...lifetime.lifetime, current: lifetime.current };

// N5 files
const files = await collectCloudFiles(cloud);
summary.files = {
  count: files.count,
  first: files.files[0]
    ? {
        name: files.files[0].old_filename,
        gcode_id: files.files[0].gcode_id,
        size: files.files[0].size,
      }
    : null,
};

// N6 errors
const errors = await collectErrorList(cloud, { printerId });
summary.errors = {
  count: errors.errors.length,
  codes: Object.keys(errors.failure_reason_codes).length,
  first_titles: errors.errors.slice(0, 3).map((e) => e.title),
};

// N11 preview from cloud files gcode (printHistory does not expose gcode_id)
const firstGcode = files.files.find((f) => f.gcode_id) ?? null;
if (firstGcode?.gcode_id) {
  const preview = await collectFilePreview(cloud, { gcodeId: firstGcode.gcode_id });
  summary.preview = {
    gcode_id: preview.gcode_id,
    name: preview.name,
    layers: preview.layers,
    used_filament_g: preview.used_filament_g,
    per_color: preview.per_color,
    dimensions: preview.dimensions,
  };
} else {
  summary.preview = { note: "no gcode_id in cloud files; skipped" };
}

// registry (offline)
const registry = orderRegistry();
summary.registry = {
  validated: Object.keys(registry.validated_live).length,
  reference: Object.keys(registry.from_reference_AnycubicOrderID_IntEnum).length,
};

// Batch 2: projects
try {
  const projects = await collectCloudProjects(cloud, { printerId });
  summary.projects = { count: projects.count, read_only: projects.read_only };
} catch (e) {
  summary.projects = { state: "error", error: e.message };
}

// Batch 2: print metrics (N1 aggregate)
try {
  const metrics = await collectPrintMetrics(cloud, { printerId, limit: 100 });
  summary.print_metrics = {
    outcomes: metrics.outcomes,
    failure_breakdown: metrics.failure_breakdown,
    failure_rate_pct: metrics.failure_rate_pct,
    success_rate_pct: metrics.success_rate_pct,
  };
} catch (e) {
  summary.print_metrics = { state: "error", error: e.message };
}

// Batch 2: Prometheus expose (N15)
try {
  const expose = collectMetricsExpose(snapshot, { printerId });
  summary.metrics_expose = {
    format: expose.format,
    metrics_present: expose.metrics_present,
    sample: expose.text.split("\n").filter((l) => l.startsWith("printer_")).slice(0, 6),
  };
} catch (e) {
  summary.metrics_expose = { state: "error", error: e.message };
}

// Batch 1/Batch 2 edge (read-only): firmware check + event watch + camera info
try {
  const fw = await checkFirmwareUpdate(cloud, { printerId });
  summary.firmware = { state: fw.ota?.state ?? "ok", current: fw.ota?.current, has_update: fw.ota?.has_update };
} catch (e) {
  summary.firmware = { state: "error", error: e.message };
}
try {
  const w1 = await collectEventWatch(cloud, { printerId, reset: true });
  const w2 = await collectEventWatch(cloud, { printerId });
  summary.event_watch = { since: w1.since, events1: w1.events.length, events2: w2.events.length, second_types: w2.events.map((e) => e.type) };
} catch (e) {
  summary.event_watch = { state: "error", error: e.message };
}
try {
  const cam = await collectCameraCloudInfo(cloud, { printerId });
  summary.camera = { rtc_supported: cam.camera?.rtc_supported, video_taskid: cam.camera?.video_taskid, timelapse: cam.camera?.timelapse_supported };
} catch (e) {
  summary.camera = { state: "error", error: e.message };
}

console.log(JSON.stringify(summary, null, 1));

// detail probe (optional best-effort)
try {
  if (history.entries[0]?.task_id) {
    const detail = await collectPrintHistoryDetail(cloud, { taskId: history.entries[0].task_id });
    summary.detail = { task_id: detail.task_id, has_data: Boolean(detail.data) };
    console.log("\nDETAIL: " + JSON.stringify(detail.data ?? null)?.slice(0, 300));
  }
} catch (e) {
  summary.detail = { state: "error", error: e.message };
  console.log("\nDETAIL_ERROR: " + e.message);
}

