/**
 * Anycubic Kobra S1 — exhaustive property & endpoint catalog.
 *
 * Purpose: a single declarative source of truth for EVERY read point and every
 * command/connection point reachable on the printer, the LAN transport and the
 * Anycubic cloud account. Consumed by `printer-full-read.mjs` (MCP tools) and by
 * the tests, so a newly observed field is either matched to a catalog entry or
 * reported as `extra` (i.e. an unmapped discovery that must be documented).
 *
 * Evidence levels (never upgrade a level without evidence):
 *  - "live"        verified against captured traffic from the real printer
 *                  (docs/evidence/cloud-<PRINTER_ID>-*.json, .sweep-events.json)
 *  - "mapping"     command mapping documented by the validated LAN protocol
 *                  reference; publishing path confirmed, semantics not re-measured
 *  - "reference"   present in the vendor/reference API surface but NOT validated
 *                  on this hardware; treat as hypothesis
 *  - "hypothesis"  inferred from protocol shape only — must not be used to act
 *
 * Safety classes for commands:
 *  - "read"        no physical effect
 *  - "state"       changes reversible non-motion state (light, fan, ACE metadata)
 *  - "thermal"     changes heaters — can burn / deform
 *  - "motion"      moves axes — can crash into the part
 *  - "job"         starts/stops a print — irreversible for the part on the bed
 */
import { HTTP_PROPERTY_CATALOG } from "./printer-http-property-catalog.mjs";

export { HTTP_PROPERTY_CATALOG };

export const PRINTER_MODEL = Object.freeze({
  model_id: "20025",
  family: "Kobra S1",
  firmware_observed: process.env.ANYCUBIC_FW_VERSION ?? "unknown",
  cloud_printer_id: Number(process.env.ANYCUBIC_PRINTER_ID ?? 0),
  ace_model_id: 40002,
  bed_mm: { x: 250, y: 250, z: 260 },
});

/** Cloud MQTT topic roots. Command side is `pc/`, report side is `app/`+`public/`. */
export const CLOUD_TOPICS = Object.freeze({
  command: "anycubic/anycubicCloud/v1/pc/printer/{model_id}/{printer_key}/{type}",
  account_reports: "anycubic/anycubicCloud/v1/printer/app/{model_id}/{printer_key}/#",
  public_reports: "anycubic/anycubicCloud/v1/printer/public/{model_id}/{printer_key}/{type}/report",
  broker: "mqtts://mqtt-universe.anycubic.com:8883",
  auth: "mutual TLS (shared slicer client identity) + RSA-encrypted XX-Token",
});

/** Native LAN-mode topic roots (printer-local broker, port 9883 after handshake). */
export const LAN_TOPICS = Object.freeze({
  command: "anycubic/anycubicCloud/v1/web/printer/{model_id}/{mqtt_device_id}/{type}",
  reports: "anycubic/anycubicCloud/v1/printer/public/{model_id}/{mqtt_device_id}/{type}/report",
  info_http: "http://{ip}:18910/info",
  ctrl_http: "http://{ip}:18910/ctrl",
  camera_flv: "http://{ip}:18088/flv",
  gkapi_octoprint: "http://{ip}:80/api/version",
});

/**
 * Read sources. Every entry that has `action` is publishable to `path_template`
 * with the JSON envelope `{type, action, timestamp, msgid, data}`.
 */
export const READ_SOURCES = Object.freeze([
  {
    id: "info",
    transport: "mqtt",
    type: "info",
    action: "query",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/info",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/info",
    observed_actions: ["query", "report"],
    cadence_hint: "slow (~30s push)",
    evidence: "live",
    properties: [
      { path: "printerName", type: "string", group: "identity" },
      { path: "model", type: "string", group: "identity" },
      { path: "ip", type: "string", group: "identity" },
      { path: "version", type: "string", group: "identity" },
      { path: "state", type: "string", group: "state", note: "free = idle" },
      { path: "print_speed_mode", type: "number", group: "print" },
      { path: "fan_speed_pct", type: "number", unit: "percent", group: "cooling" },
      { path: "aux_fan_speed_pct", type: "number", unit: "percent", group: "cooling" },
      { path: "box_fan_level", type: "number", unit: "level", group: "cooling" },
      {
        path: "urls.rtspUrl",
        type: "string",
        group: "camera",
        note: "live camera URL; redacted by default",
      },
      {
        path: "urls.fileUploadurl",
        type: "string",
        group: "transfer",
        note: "signed upload URL; redacted",
      },
      { path: "temp.curr_hotbed_temp", type: "number", unit: "celsius", group: "temperature" },
      { path: "temp.curr_nozzle_temp", type: "number", unit: "celsius", group: "temperature" },
      { path: "temp.target_hotbed_temp", type: "number", unit: "celsius", group: "temperature" },
      { path: "temp.target_nozzle_temp", type: "number", unit: "celsius", group: "temperature" },
      { path: "project", type: "object|null", group: "print", note: "null when idle" },
      { path: "last_project.state", type: "string", group: "print" },
      { path: "last_project.print_status", type: "number", group: "print" },
      { path: "last_project.progress", type: "number", unit: "percent", group: "print" },
      { path: "last_project.curr_layer", type: "number", group: "print" },
      { path: "last_project.total_layers", type: "number", group: "print" },
      { path: "last_project.remain_time", type: "number", unit: "second", group: "print" },
      { path: "last_project.print_time", type: "number", unit: "second", group: "print" },
      {
        path: "last_project.supplies_usage",
        type: "number",
        unit: "millimeter",
        group: "material",
      },
      {
        path: "last_project.pause",
        type: "number",
        group: "print",
        note: "authoritative pause state 0-4",
      },
      { path: "last_project.project_type", type: "number", group: "print" },
      { path: "last_project.task_id", type: "number", group: "print" },
      { path: "last_project.localtask", type: "string", group: "print" },
      { path: "last_project.filename", type: "string", group: "print" },
      { path: "last_project.print_speed_mode", type: "object", group: "print" },
      { path: "last_project.task_settings.camera_timelapse", type: "number", group: "camera" },
      { path: "features.auto_leveling_support", type: "boolean", group: "capability" },
      { path: "features.vibration_compensation_support", type: "boolean", group: "capability" },
      { path: "features.flow_calibration_support", type: "boolean", group: "capability" },
      { path: "features.drying_first_support", type: "boolean", group: "capability" },
      { path: "features.camera_timelapse_support", type: "boolean", group: "capability" },
      { path: "features.gcode_3mf_support", type: "boolean", group: "capability" },
      { path: "features.delete_batch_support", type: "boolean", group: "capability" },
      { path: "features.preheating_support", type: "boolean", group: "capability" },
      {
        path: "features.fod_support",
        type: "boolean",
        group: "capability",
        note: "on-device AI failure detection",
      },
      {
        path: "features.shengwang_rtc_support",
        type: "boolean",
        group: "capability",
        note: "Agora RTC (cloud camera)",
      },
      { path: "features.shengwang_rdt_support", type: "boolean", group: "capability" },
      { path: "features.pre_cancel_support", type: "boolean", group: "capability" },
    ],
  },
  {
    id: "tempature",
    transport: "mqtt",
    type: "tempature",
    action: "query",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/tempature",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/tempature",
    observed_actions: ["query", "auto"],
    cadence_hint: "fast push (~1s)",
    evidence: "live",
    note: "topic name is intentionally misspelled by the vendor ('tempature').",
    properties: [
      { path: "curr_hotbed_temp", type: "number", unit: "celsius", group: "temperature" },
      { path: "curr_nozzle_temp", type: "number", unit: "celsius", group: "temperature" },
      { path: "curr_chamber_temp", type: "number", unit: "celsius", group: "temperature" },
      { path: "target_hotbed_temp", type: "number", unit: "celsius", group: "temperature" },
      { path: "target_nozzle_temp", type: "number", unit: "celsius", group: "temperature" },
      { path: "target_chamber_temp", type: "number", unit: "celsius", group: "temperature" },
      { path: "taskid", type: "string", group: "print" },
    ],
  },
  {
    id: "fan",
    transport: "mqtt",
    type: "fan",
    action: "query",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/fan",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/fan",
    observed_actions: ["query"],
    evidence: "live",
    properties: [
      {
        path: "fan_speed_pct",
        type: "number",
        unit: "percent",
        group: "cooling",
        note: "part cooling fan",
      },
      {
        path: "aux_fan_speed_pct",
        type: "number",
        unit: "percent",
        group: "cooling",
        note: "auxiliary fan",
      },
      {
        path: "box_fan_level",
        type: "number",
        unit: "level",
        group: "cooling",
        note: "ACE / chamber fan",
      },
    ],
  },
  {
    id: "light",
    transport: "mqtt",
    type: "light",
    action: "query",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/light",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/light",
    observed_actions: ["query"],
    evidence: "live",
    properties: [
      { path: "lights[].type", type: "number", group: "lighting", note: "2 = chamber light" },
      { path: "lights[].status", type: "number", group: "lighting" },
      { path: "lights[].brightness", type: "number", unit: "percent", group: "lighting" },
    ],
  },
  {
    id: "peripherie",
    transport: "mqtt",
    type: "peripherie",
    action: "query",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/peripherie",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/peripherie",
    observed_actions: ["query"],
    evidence: "live",
    properties: [
      { path: "camera", type: "number", group: "peripheral", note: "1 = camera present" },
      { path: "multiColorBox", type: "number", group: "peripheral", note: "1 = ACE present" },
      { path: "udisk", type: "number", group: "peripheral", note: "1 = USB storage present" },
    ],
  },
  {
    id: "aiSettings",
    transport: "mqtt",
    type: "aiSettings",
    action: "query",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/aiSettings",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/aiSettings",
    observed_actions: ["query"],
    evidence: "live",
    note: "read side of the on-device AI failure detection (fod_support).",
    properties: [
      { path: "ai_settings.status", type: "number", group: "ai", note: "3 = enabled" },
      { path: "ai_settings.type", type: "number", group: "ai" },
      { path: "ai_settings.count", type: "number", group: "ai" },
      { path: "ai_settings.notice_type", type: "array", group: "ai" },
      { path: "ai_settings.sensitivity_level", type: "array", group: "ai" },
    ],
  },
  {
    id: "multiColorBox",
    transport: "mqtt",
    type: "multiColorBox",
    action: "getInfo",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/multiColorBox",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/multiColorBox",
    observed_actions: ["getInfo"],
    evidence: "live",
    note: "activity-gated: use action getInfo (not query) and poll.",
    properties: [
      { path: "head_tools_model", type: "number", group: "ace" },
      { path: "multi_color_box[].id", type: "number", group: "ace" },
      { path: "multi_color_box[].status", type: "number", group: "ace" },
      { path: "multi_color_box[].model_id", type: "number", group: "ace", note: "40002 = ACE Pro" },
      { path: "multi_color_box[].auto_feed", type: "number", group: "ace" },
      {
        path: "multi_color_box[].loaded_slot",
        type: "number",
        group: "ace",
        note: "-1 = no slot fed",
      },
      { path: "multi_color_box[].temp", type: "number", unit: "celsius", group: "ace" },
      { path: "multi_color_box[].humidity", type: "number", unit: "percent", group: "ace" },
      { path: "multi_color_box[].feed_status.code", type: "number", group: "ace" },
      { path: "multi_color_box[].feed_status.type", type: "number", group: "ace" },
      { path: "multi_color_box[].feed_status.current_status", type: "number", group: "ace" },
      { path: "multi_color_box[].feed_status.slot_index", type: "number", group: "ace" },
      { path: "multi_color_box[].drying_status.status", type: "number", group: "ace" },
      {
        path: "multi_color_box[].drying_status.target_temp",
        type: "number",
        unit: "celsius",
        group: "ace",
      },
      {
        path: "multi_color_box[].drying_status.duration",
        type: "number",
        unit: "minute",
        group: "ace",
      },
      {
        path: "multi_color_box[].drying_status.remain_time",
        type: "number",
        unit: "minute",
        group: "ace",
      },
      { path: "multi_color_box[].slots[].index", type: "number", group: "ace" },
      {
        path: "multi_color_box[].slots[].type",
        type: "string",
        group: "ace",
        note: "material name",
      },
      {
        path: "multi_color_box[].slots[].sku",
        type: "string",
        group: "ace",
        note: "Anycubic spool SKU",
      },
      { path: "multi_color_box[].slots[].color", type: "array", group: "ace", note: "[R,G,B]" },
      {
        path: "multi_color_box[].slots[].color_group",
        type: "array",
        group: "ace",
        note: "[[R,G,B,A]]",
      },
      {
        path: "multi_color_box[].slots[].edit_status",
        type: "number",
        group: "ace",
        note: "0 = RFID tag, 1 = manually entered",
      },
      {
        path: "multi_color_box[].slots[].status",
        type: "number",
        group: "ace",
        note: "5 = loaded/ready",
      },
      { path: "multi_color_box[].slots[].icon_type", type: "number", group: "ace" },
      {
        path: "multi_color_box[].slots[].consumables_percent",
        type: "number",
        unit: "percent",
        group: "material",
      },
    ],
  },
  {
    id: "axis",
    transport: "mqtt",
    type: "axis",
    action: "query",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/axis",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/axis",
    observed_actions: ["query"],
    evidence: "live",
    note: "reported coordinates are NOT a homing reference and do not prove origin/offsets.",
    properties: [
      { path: "coordinates.x", type: "number", unit: "millimeter", group: "motion" },
      { path: "coordinates.y", type: "number", unit: "millimeter", group: "motion" },
      { path: "coordinates.z", type: "number", unit: "millimeter", group: "motion" },
    ],
  },
  {
    id: "extfilbox",
    transport: "mqtt",
    type: "extfilbox",
    action: "query",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/extfilbox",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/extfilbox",
    observed_actions: ["query", "reportInfo"],
    evidence: "live",
    note: "external single-slot filament holder (not ACE). Timed out on an idle printer.",
    properties: [
      { path: "type", type: "string", group: "material" },
      { path: "color", type: "array", group: "material", note: "[R,G,B]" },
      { path: "loaded", type: "number", group: "material" },
      { path: "status_type", type: "number", group: "material" },
      { path: "current_status", type: "number", group: "material" },
    ],
  },
  {
    id: "print",
    transport: "mqtt",
    type: "print",
    action: "query",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/print",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/print",
    observed_actions: ["query"],
    evidence: "reference",
    note: "no reply observed within 20s on a failed/idle printer; NOT proof the capability is absent.",
    properties: [
      { path: "taskid", type: "string", group: "print" },
      { path: "state", type: "string", group: "print" },
      { path: "settings", type: "object", group: "print" },
      {
        path: "settings.target_nozzle_temp",
        type: "number",
        unit: "celsius",
        group: "temperature",
      },
      {
        path: "settings.target_hotbed_temp",
        type: "number",
        unit: "celsius",
        group: "temperature",
      },
      { path: "settings.fan_speed_pct", type: "number", unit: "percent", group: "cooling" },
      { path: "settings.aux_fan_speed_pct", type: "number", unit: "percent", group: "cooling" },
      { path: "settings.box_fan_level", type: "number", unit: "level", group: "cooling" },
      { path: "settings.print_speed_mode", type: "number", group: "print" },
    ],
  },
  {
    id: "file",
    transport: "mqtt",
    type: "file",
    action: "listLocal",
    cloud_publish: "pc/printer/{model_id}/{printer_key}/file",
    lan_publish: "web/printer/{model_id}/{mqtt_device_id}/file",
    observed_actions: ["listLocal", "listUdisk", "getPreSignedUrl", "saveVideoThumbnail"],
    evidence: "live",
    note: "listLocal and listUdisk are separated so one reply cannot satisfy the other query.",
    properties: [
      { path: "list_mode", type: "number", group: "storage" },
      { path: "records[].filename", type: "string", group: "storage" },
      { path: "records[].is_dir", type: "boolean", group: "storage" },
      { path: "records[].timestamp", type: "number", unit: "second", group: "storage" },
      { path: "records[].size", type: "number", unit: "byte", group: "storage" },
      { path: "records[].plate_number", type: "number", group: "storage" },
      { path: "filename", type: "string", group: "storage" },
      { path: "fileSize", type: "number", unit: "byte", group: "storage" },
      { path: "fileKey", type: "string", group: "storage" },
      { path: "path", type: "string", group: "storage" },
      { path: "thumbnailUrl", type: "string", group: "camera", note: "redacted" },
    ],
  },
  {
    id: "status",
    transport: "mqtt",
    type: "status",
    action: "report",
    cloud_publish: null,
    lan_publish: null,
    observed_actions: ["report"],
    evidence: "live",
    note: "push-only work report; no query projection observed.",
    properties: [
      { path: "state", type: "string", group: "state", note: "free | busy" },
      { path: "workReport", type: "object", group: "print" },
    ],
  },
]);

/**
 * HTTP read endpoints on the cloud workbench API.
 * `params` lists the query keys the endpoint actually consumes.
 */
export const CLOUD_HTTP_ENDPOINTS = Object.freeze([
  {
    id: "printers_status",
    path: "/work/printer/printersStatus",
    params: [],
    evidence: "reference",
  },
  { id: "printer_status", path: "/v2/Printer/status", params: ["id"], evidence: "live" },
  {
    id: "printer_info",
    path: "/v2/printer/info",
    params: ["id"],
    evidence: "live",
    note: "richest single source: 128 fields",
  },
  {
    id: "printer_tool",
    path: "/v2/printer/tool",
    params: ["id", "model_id", "type_function_id"],
    evidence: "live",
    note: "type_function_id must be positive (13 = XYZ tool)",
  },
  {
    id: "printer_functions",
    path: "/v2/printer/functions",
    params: ["id", "model_id"],
    evidence: "live",
    note: "returned Photon S metadata for Kobra S1 inputs — not a reliable capability list",
  },
  { id: "printer_all", path: "/v2/printer/all", params: ["id"], evidence: "reference" },
  {
    id: "print_history",
    path: "/v2/project/printHistory",
    params: ["page", "limit", "print_status"],
    evidence: "reference",
  },
  {
    id: "print_history_detail",
    path: "/v5/project/printHistory/detail",
    params: ["task_id"],
    evidence: "live",
  },
  {
    id: "project_info",
    path: "/v2/project/info",
    params: ["id"],
    evidence: "live",
    note: "126 fields incl. slice_param/slice_result and device_message",
  },
  { id: "project_monitor", path: "/v2/project/monitor", params: ["id"], evidence: "live" },
  {
    id: "work_project_error_list",
    path: "/v3/work_project/getErrorList",
    params: ["id"],
    evidence: "reference",
  },
  {
    id: "project_list",
    path: "/work/project/getProjects",
    params: ["page", "limit", "print_status"],
    evidence: "reference",
  },
  {
    id: "gcode_info",
    path: "/work/gcode/info",
    params: ["id"],
    evidence: "reference",
    note: "id is the G-code id, not the task id",
  },
  {
    id: "gcode_info_fdm",
    path: "/work/gcode/infoFdm",
    params: ["id"],
    evidence: "live",
    note: "resolves gcode_id -> cloud file id + slice metadata (63 fields)",
  },
  { id: "cloud_file_info", path: "/farm/file/info", params: ["id"], evidence: "reference" },
  {
    id: "model_file_info",
    path: "/work/index/getModelFileInfo",
    params: ["id"],
    evidence: "reference",
  },
  {
    id: "multi_color_box_info",
    path: "/v2/printer/getMultiColorBoxInfo",
    params: ["id"],
    evidence: "live",
    note: "initial /v2/printer/multiColorBoxInfo returned 404",
  },
  {
    id: "video_thumbnail_list",
    path: "/v3/printer/getVideoThumbnailList",
    params: ["device_id"],
    evidence: "reference",
  },
  { id: "printer_getPrinters", path: "/work/printer/getPrinters", params: [], evidence: "live" },
  { id: "user_files", path: "/work/index/userFiles", params: [], evidence: "live" },
  { id: "user_profile", path: "/v1/user/profile/userInfo", params: [], evidence: "live" },
  {
    id: "login",
    path: "/v3/public/loginWithAccessToken",
    params: [],
    method: "POST",
    evidence: "live",
    note: "legacy /uapi/account/xxLogin returns HTTP 405",
  },
  {
    id: "send_order",
    path: "/work/operation/sendOrder",
    params: [],
    method: "POST",
    evidence: "live",
    note: "accepted orders are NOT proof the device executed them",
  },
]);

/** Read-only HTTP surface exposed by the printer itself. */
export const PRINTER_HTTP_ENDPOINTS = Object.freeze([
  {
    id: "version",
    path: "/api/version",
    result: "200 — self-identifies as OctoPrint 1.8.7 (API 0.1)",
    evidence: "live",
  },
  { id: "printer", path: "/api/printer", result: "404", evidence: "live" },
  { id: "job", path: "/api/job", result: "404", evidence: "live" },
  { id: "connection", path: "/api/connection", result: "404", evidence: "live" },
  { id: "files", path: "/api/files", result: "404", evidence: "live" },
  { id: "settings", path: "/api/settings", result: "404", evidence: "live" },
  { id: "logs", path: "/api/logs", result: "404", evidence: "live" },
  { id: "server_info", path: "/server/info", result: "404", evidence: "live" },
  { id: "objects", path: "/printer/objects/list", result: "404", evidence: "live" },
  { id: "info", path: "/info", result: "404", evidence: "live" },
]);

/**
 * Command / connection map — every writable channel discovered, with its safety
 * class and evidence level. Read-only by construction: this is a description,
 * not an executor. Fields are the payload keys the command expects.
 */
export const COMMAND_MAP = Object.freeze([
  {
    type: "print",
    action: "pause",
    data: { taskid: "task id" },
    safety: "job",
    evidence: "mapping",
  },
  {
    type: "print",
    action: "resume",
    data: { taskid: "task id" },
    safety: "job",
    evidence: "mapping",
  },
  {
    type: "print",
    action: "stop",
    data: { taskid: "-1 to stop current" },
    safety: "job",
    evidence: "mapping",
  },
  {
    type: "print",
    action: "update",
    data: {
      taskid: "task id",
      settings:
        "subset of target_nozzle_temp/target_hotbed_temp/fan_speed_pct/aux_fan_speed_pct/box_fan_level/print_speed_mode",
    },
    safety: "thermal",
    evidence: "mapping",
    note: "changes the RUNNING job; it is not a refresh/status query",
  },
  {
    type: "print",
    action: "start",
    data: { taskid: "task id", file: "remote path" },
    safety: "job",
    evidence: "reference",
    note: "LAN start payload not verified for this Kobra S1",
  },
  { type: "print", action: "query", data: null, safety: "read", evidence: "reference" },
  {
    type: "tempature",
    action: "set",
    data: {
      type: "0 noz / 1 bed / 2 both",
      target_nozzle_temp: "celsius",
      target_hotbed_temp: "celsius",
    },
    safety: "thermal",
    evidence: "mapping",
  },
  { type: "tempature", action: "query", data: null, safety: "read", evidence: "live" },
  {
    type: "tempature",
    action: "auto",
    data: null,
    safety: "thermal",
    evidence: "reference",
    note: "observed as a report action; publish semantics unverified",
  },
  {
    type: "fan",
    action: "setSpeed",
    data: { fan_speed_pct: "0-100", aux_fan_speed_pct: "0-100", box_fan_level: "level" },
    safety: "state",
    evidence: "mapping",
    note: "slicer sends exactly one key per call",
  },
  { type: "fan", action: "query", data: null, safety: "read", evidence: "live" },
  {
    type: "light",
    action: "control",
    data: { type: "2 = chamber", status: "0|1", brightness: "0-100" },
    safety: "state",
    evidence: "live",
    note: "physically executed and confirmed via light/report",
  },
  { type: "light", action: "query", data: null, safety: "read", evidence: "live" },
  { type: "axis", action: "query", data: null, safety: "read", evidence: "live" },
  {
    type: "axis",
    action: "move",
    data: { axis: "x|y|z", move_type: "move|home", distance: "millimeter" },
    safety: "motion",
    evidence: "mapping",
    note: "homexy executed physically during validation",
  },
  {
    type: "axis",
    action: "turnOff",
    data: null,
    safety: "motion",
    evidence: "mapping",
    note: "disables stepper holding torque",
  },
  { type: "peripherie", action: "query", data: null, safety: "read", evidence: "live" },
  { type: "aiSettings", action: "query", data: null, safety: "read", evidence: "live" },
  {
    type: "aiSettings",
    action: "switch",
    data: {
      ai_settings: {
        status: "3 on / 0 off",
        type: "",
        count: "",
        sensitivity_level: "",
        notice_type: "",
      },
    },
    safety: "state",
    evidence: "reference",
    note: "cloud order id 1243; LAN action name unverified",
  },
  { type: "multiColorBox", action: "getInfo", data: null, safety: "read", evidence: "live" },
  {
    type: "multiColorBox",
    action: "setDry",
    data: {
      multi_color_box: [
        {
          id: "box id",
          drying_status: {
            status: "1 start / 0 stop",
            target_temp: "celsius",
            duration: "minutes",
          },
        },
      ],
    },
    safety: "thermal",
    evidence: "mapping",
  },
  {
    type: "multiColorBox",
    action: "feedFilament",
    data: {
      multi_color_box: [
        { id: "box id", feed_status: { slot_index: "slot", type: "feed direction" } },
      ],
    },
    safety: "motion",
    evidence: "mapping",
  },
  {
    type: "multiColorBox",
    action: "setInfo",
    data: {
      multi_color_box: [
        { id: "box id", slots: [{ index: "slot", type: "material", color: "[R,G,B]" }] },
      ],
    },
    safety: "state",
    evidence: "mapping",
    note: "legitimate manual-filament path (mirrors edit_status=1)",
  },
  {
    type: "multiColorBox",
    action: "setAutoFeed",
    data: { multi_color_box: [{ id: "box id", auto_feed: "0|1" }] },
    safety: "state",
    evidence: "mapping",
  },
  { type: "file", action: "listLocal", data: null, safety: "read", evidence: "live" },
  { type: "file", action: "listUdisk", data: null, safety: "read", evidence: "live" },
  {
    type: "file",
    action: "getPreSignedUrl",
    data: { path: "", filename: "" },
    safety: "read",
    evidence: "live",
  },
  {
    type: "file",
    action: "saveVideoThumbnail",
    data: { filename: "", fileKey: "", thumbnailUrl: "" },
    safety: "read",
    evidence: "live",
  },
  {
    type: "file",
    action: "deleteLocal",
    data: { filename: "" },
    safety: "state",
    evidence: "reference",
    note: "destructive; not validated",
  },
  {
    type: "file",
    action: "deleteUdisk",
    data: { filename: "" },
    safety: "state",
    evidence: "reference",
    note: "destructive; not validated",
  },
  {
    type: "video",
    action: "startCapture",
    data: null,
    safety: "state",
    evidence: "mapping",
    note: "starts the camera stream",
  },
  { type: "video", action: "stopCapture", data: null, safety: "state", evidence: "mapping" },
  { type: "extfilbox", action: "query", data: null, safety: "read", evidence: "reference" },
  { type: "info", action: "query", data: null, safety: "read", evidence: "live" },
]);

/**
 * Legacy HTTP `sendOrder` identifiers.
 * START_PRINT=1 / PAUSE=2 / RESUME=3 / STOP=4 follow the reference
 * AnycubicOrderID IntEnum and were LIVE-VALIDATED 2026-09-11 (task <TASK_ID>
 * started the physical printer; STOP_PRINT cleared residual task <TASK_ID>).
 * The old 1240/1241/1242 hypothesis answered "Operation successful" yet never
 * created a task. Other ids are descriptive only — never use an unvalidated id
 * to discover semantics.
 */
export const LEGACY_ORDER_IDS = Object.freeze({
  START_PRINT: 1,
  PAUSE_PRINT: 2,
  RESUME_PRINT: 3,
  STOP_PRINT: 4,
  SET_AI_SETTINGS: 1243,
  SET_TEMPERATURE: 1214,
  SET_FAN_SPEED: 1215,
  SET_PRINT_SPEED: 1216,
  SET_LIGHT_STATUS: 1217,
  MOVE_AXLE: 1226,
  MOVE_AXLE_TURN_OFF: 1227,
  QUERY_AXIS_POSITION: 1214,
  LIST_LOCAL_FILES: 103,
  LIST_UDISK_FILES: 1235,
  DELETE_LOCAL_FILE: 1236,
  DELETE_UDISK_FILE: 1237,
  QUERY_PERIPHERALS: 1231,
  GET_LIGHT_STATUS: 1232,
  MULTI_COLOR_BOX_GET_INFO: 1206,
  MULTI_COLOR_BOX_DRY: 1251,
  MULTI_COLOR_BOX_AUTO_FEED: 1252,
  MULTI_COLOR_BOX_SET_SLOT: 1253,
  FEED_FILAMENT: 1254,
  CAMERA_OPEN: 1260,
});

/** Validated HTTP read order ids (corrected and tested against the live device). */
export const VALIDATED_HTTP_READ_ORDER_IDS = Object.freeze({
  axis: 1214,
  peripherie: 1231,
  light: 1232,
  multiColorBox: 1206,
  local_files: 103,
  usb_files: 101,
});

export const LIFECYCLE_STATES = Object.freeze([
  "preheating",
  "auto_leveling",
  "vibrating",
  "flow_calibrating",
  "printing",
  "pausing",
  "paused",
  "resuming",
  "resumed",
  "stopping",
  "stoped",
  "finished",
  "failed",
]);

export const DEFAULT_PORT_SCAN = Object.freeze([
  18910, 9883, 990, 21, 8883, 80, 18088, 18086, 1883, 7125, 22,
]);

/**
 * Actions that are read-only by definition. Every entry in `QUERYABLE_SOURCES`
 * must use one of these, so the reader can never publish a mutating action.
 */
export const READ_ONLY_ACTIONS = Object.freeze([
  "query",
  "getInfo",
  "reportInfo",
  "listLocal",
  "listUdisk",
  "getPreSignedUrl",
  "saveVideoThumbnail",
  "report",
]);

/**
 * Flatten an arbitrary payload into `path -> leaf value` pairs (arrays as `[]`).
 * First occurrence wins for array elements, so the shape is stable regardless of
 * how many elements the printer reported.
 */
export function flattenProperties(value, prefix = "", out = {}, depth = 0) {
  if (depth > 12 || value === null || value === undefined) {
    if (prefix && !(prefix in out)) out[prefix] = value ?? null;
    return out;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      if (!(prefix in out)) out[prefix] = [];
      return out;
    }
    for (const item of value) flattenProperties(item, `${prefix}[]`, out, depth + 1);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      flattenProperties(child, prefix ? `${prefix}.${key}` : key, out, depth + 1);
    }
    return out;
  }
  if (!(prefix in out)) out[prefix] = value;
  return out;
}

function normalizeTemplatePath(path) {
  return path.replace(/\[\]/g, "[]");
}

function leafValueAt(payload, path) {
  const segments = path.split(".").flatMap((segment) => {
    const match = segment.match(/^([^[\]]+)((\[\])*)$/);
    if (!match) return [[segment, 0]];
    const brackets = (match[2].match(/\[\]/g) ?? []).length;
    return [[match[1], brackets]];
  });
  let current = payload;
  for (const [key, brackets] of segments) {
    if (Array.isArray(current)) {
      const found = current.map((item) => item?.[key]).find((item) => item !== undefined);
      current = found;
    } else if (current && typeof current === "object") {
      current = current[key];
    } else {
      return undefined;
    }
    for (let i = 0; i < brackets; i += 1) {
      current = Array.isArray(current) ? current[0] : undefined;
    }
    if (current === undefined || current === null) return current;
  }
  return current;
}

/**
 * Match a live payload against a catalog property list.
 * Returns matched (with value), missing catalog entries and unmapped extra fields.
 */
export function matchProperties(payload, propertyList) {
  const flat = flattenProperties(payload ?? {});
  const matched = [];
  const missing = [];
  const consumed = new Set();
  const declared = new Set();

  for (const property of propertyList) {
    const path = normalizeTemplatePath(property.path);
    declared.add(path);
    const value = leafValueAt(payload ?? {}, property.path);
    if (value === undefined) {
      missing.push(path);
      continue;
    }
    matched.push({
      path,
      value,
      type: property.type,
      unit: property.unit ?? null,
      group: property.group ?? null,
      label: property.label ?? null,
      note: property.note ?? null,
    });
    for (const flatPath of Object.keys(flat)) {
      if (flatPath === path || flatPath.startsWith(`${path}.`) || flatPath.startsWith(`${path}[`))
        consumed.add(flatPath);
    }
  }

  const extra = Object.keys(flat).filter(
    (flatPath) => !consumed.has(flatPath) && !declared.has(flatPath),
  );
  return {
    matched,
    missing,
    extra,
    observed_count: matched.length,
    catalog_count: propertyList.length,
  };
}

export function sourceById(id) {
  return READ_SOURCES.find((source) => source.id === id) ?? null;
}

export function sourcesByTransport(transport) {
  return READ_SOURCES.filter((source) => source.transport === transport);
}

export function commandByTypeAction(type, action) {
  return COMMAND_MAP.find((entry) => entry.type === type && entry.action === action) ?? null;
}

/** Total declared property paths across every read source. */
export function catalogStats() {
  const bySource = {};
  let total = 0;
  for (const source of READ_SOURCES) {
    bySource[source.id] = source.properties.length;
    total += source.properties.length;
  }
  const byEvidence = {};
  for (const source of READ_SOURCES) {
    byEvidence[source.evidence] = (byEvidence[source.evidence] ?? 0) + source.properties.length;
  }
  const byHttpEndpoint = {};
  let httpTotal = 0;
  for (const [kind, entry] of Object.entries(HTTP_PROPERTY_CATALOG)) {
    byHttpEndpoint[kind] = entry.properties.length;
    httpTotal += entry.properties.length;
  }
  const httpEvidence = {};
  for (const entry of Object.values(HTTP_PROPERTY_CATALOG)) {
    httpEvidence[entry.evidence] = (httpEvidence[entry.evidence] ?? 0) + entry.properties.length;
  }
  return {
    sources: READ_SOURCES.length,
    total_properties: total,
    by_source: bySource,
    by_evidence: byEvidence,
    http_endpoints_with_catalog: Object.keys(HTTP_PROPERTY_CATALOG).length,
    http_properties: httpTotal,
    by_http_endpoint: byHttpEndpoint,
    http_by_evidence: httpEvidence,
    grand_total_properties: total + httpTotal,
    commands: COMMAND_MAP.length,
    cloud_http_endpoints: CLOUD_HTTP_ENDPOINTS.length,
    printer_http_endpoints: PRINTER_HTTP_ENDPOINTS.length,
  };
}

/**
 * Match an HTTP endpoint payload against its generated property catalog, so the
 * same extra/missing reporting used for MQTT also applies to the HTTP surface
 * (printer_info alone declares 128 paths).
 */
export function matchHttpProperties(kind, payload) {
  const entry = HTTP_PROPERTY_CATALOG[kind];
  if (!entry) return null;
  const flat = flattenProperties(payload ?? {});
  const consumed = new Set();
  const matched = [];
  const missing = [];
  for (const property of entry.properties) {
    const path = normalizeTemplatePath(property.path);
    const value = leafValueAt(payload ?? {}, property.path);
    if (value === undefined) {
      missing.push(path);
      continue;
    }
    matched.push({ path, value, unit: property.unit ?? null, group: property.group ?? null });
    for (const flatPath of Object.keys(flat)) {
      if (flatPath === path || flatPath.startsWith(`${path}.`) || flatPath.startsWith(`${path}[`))
        consumed.add(flatPath);
    }
  }
  const declared = new Set(
    entry.properties.map((property) => normalizeTemplatePath(property.path)),
  );
  const extra = Object.keys(flat).filter(
    (flatPath) => !consumed.has(flatPath) && !declared.has(flatPath),
  );
  return {
    kind,
    endpoint: entry.path,
    evidence: entry.evidence,
    catalog_count: entry.properties.length,
    observed_count: matched.length,
    coverage_pct: entry.properties.length
      ? Math.round((matched.length / entry.properties.length) * 1000) / 10
      : 0,
    matched,
    missing,
    extra,
  };
}

export function httpCatalog() {
  return Object.entries(HTTP_PROPERTY_CATALOG).map(([kind, entry]) => ({
    kind,
    path: entry.path,
    evidence: entry.evidence,
    note: entry.note ?? null,
    property_count: entry.properties.length,
  }));
}
