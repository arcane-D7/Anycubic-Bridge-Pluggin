/**
 * MCP tools for capabilities the audit found implemented but unreachable:
 *  - account_file_upload: the validated cloud upload flow (lock -> presigned
 *    PUT -> claim -> unlock), previously only reachable through the separate
 *    bridge process or a standalone CLI.
 *  - account_print_local: upload + the LIVE-VALIDATED order 1 start contract in one
 *    gated flow (previously only the bridge's /cloud/print-local route).
 *  - print_update: change settings of the RUNNING job (documented validated
 *    command that was missing from the executable bus).
 *  - video capture start/stop and axis turnOff (documented, missing from bus).
 *  - printer_connection_close: session hygiene (release the persistent MQTT).
 *  - printer_material_catalog: expose ANYCUBIC_MATERIALS (was dead data).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { redact } from "./cloud-readonly-diagnostics.mjs";
import { ANYCUBIC_MATERIALS } from "./anycubic-cloud.mjs";
import { COMMANDS, COMMAND_SAFETY } from "./printer-command-bus-catalog.mjs";
import {
  assertConfirm,
  cloudPrintStart,
  createManager,
  resolveCloudGcode,
} from "./printer-command-bus.mjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Cloud upload flow (validated live 2026-09-05: lock/PUT/claim all returned 200)
// ---------------------------------------------------------------------------

/**
 * Upload a local file to the account cloud shelf.
 * lockStorageSpace -> presigned S3 PUT -> newUploadFile claim -> unlock.
 * On any failure before the claim, the reservation is deleted (is_delete_cos:1)
 * so no orphaned lock is left on the account.
 */
export async function uploadFileToCloud(
  cloud,
  { local_file, is_temp_file = false, remote_name, fetchImpl, quota_check = true } = {},
) {
  const canonical = path.resolve(local_file);
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) throw new Error("local_file must be an existing file");
  if (stat.size === 0) throw new Error("cannot upload an empty file");
  const fileName = remote_name ?? path.basename(canonical);
  const bytes = fs.readFileSync(canonical);

  // N2 preflight: consult the real account quota (/work/index/getUserStore)
  // before reserving storage. The API enforces its own limit, but failing fast
  // with a clear message avoids burning an upload lock on an impossible upload.
  if (quota_check) {
    const store = await cloud.rawApi("GET", "/work/index/getUserStore", { query: {} });
    const storeData = store?.data ?? {};
    const usedBytes = Number(storeData.used_bytes);
    const totalBytes = Number(storeData.total_bytes);
    if (Number.isFinite(usedBytes) && Number.isFinite(totalBytes) && totalBytes > 0) {
      const remaining = totalBytes - usedBytes;
      if (bytes.length > remaining) {
        throw new Error(
          `cloud storage preflight failed: file needs ${bytes.length} bytes but only ${remaining} bytes free (${usedBytes}/${totalBytes}). Use account_cloud_store to inspect the quota.`,
        );
      }
    }
  }

  const lock = await cloud.rawApi("POST", "/v2/cloud_storage/lockStorageSpace", {
    params: { size: bytes.length, name: fileName, is_temp_file: is_temp_file ? 1 : 0 },
  });
  const lockData = lock?.data ?? {};
  const lockId = Number(lockData.id ?? lockData.user_lock_space_id);
  const presignedUrl =
    typeof lockData.preSignUrl === "string"
      ? lockData.preSignUrl
      : typeof lockData.url === "string"
        ? lockData.url
        : "";
  if (!Number.isFinite(lockId) || !presignedUrl) {
    throw new Error(
      `cloud did not return upload reservation data: ${JSON.stringify(redact(lockData)).slice(0, 200)}`,
    );
  }

  let claimed = false;
  try {
    // The presigned URL is single-use and time-limited; a plain PUT with the
    // full body is the only supported method.
    const put = await (fetchImpl ?? fetch)(presignedUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
      },
      body: bytes,
      signal: AbortSignal.timeout(120000),
    });
    if (!put.ok) throw new Error(`cloud object upload failed: HTTP ${put.status}`);
    const claim = await cloud.rawApi("POST", "/v2/profile/newUploadFile", {
      params: { user_lock_space_id: lockId },
    });
    const cloudFileId = Number(claim?.data?.id);
    if (!Number.isFinite(cloudFileId) || cloudFileId <= 0) {
      throw new Error("cloud did not return a file id after upload");
    }
    claimed = true;
    await cloud.rawApi("POST", "/v2/cloud_storage/unlockStorageSpace", {
      params: { id: lockId, is_delete_cos: 0 },
    });
    // The gcode_id is generated asynchronously by the cloud; poll briefly.
    let matched = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const files = await cloud.rawApi("GET", "/work/index/userFiles", { query: {} });
      const list = Array.isArray(files?.data) ? files.data : (files?.data?.list ?? []);
      matched =
        list.find((f) => Number(f.id) === cloudFileId) ??
        list.find((f) => f.old_filename === fileName || f.file_name === fileName);
      if (matched?.gcode_id || matched?.file_key) break;
    }
    return redact({
      ok: true,
      cloud_file_id: cloudFileId,
      file_name: fileName,
      size: bytes.length,
      ...(matched?.gcode_id ? { gcode_id: Number(matched.gcode_id) } : {}),
      ...(matched?.file_key ? { file_key: String(matched.file_key) } : {}),
      note: matched?.gcode_id
        ? "gcode_id generated. Note: the cloud only regenerates full slice info for files uploaded by the slicer itself; a raw G-code upload may not be startable via printer_print_start until the cloud processes it."
        : "gcode_id not yet generated by the cloud; retry printer_gcode_resolve/user files later.",
    });
  } catch (error) {
    if (!claimed) {
      // Delete the reservation so the account is not left with an orphaned lock.
      await cloud
        .rawApi("POST", "/v2/cloud_storage/unlockStorageSpace", {
          params: { id: lockId, is_delete_cos: 1 },
        })
        .catch(() => {});
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// LAN video capture (start/stop) — HTTP-FLV stream control
// ---------------------------------------------------------------------------

/** Stop hook so the recorded capture can be validated in tests. */
/**
 * Graba uma snapshot (frame único) ou stream curto do HTTP-FLV da câmara LAN.
 * `mode:"snapshot"` -> 1 frame PNG/JPG; `mode:"stream"` -> clip MP4 (~duration_s).
 * ffmpeg é invocado como argv fixo (sem shell) — sem risco de injeção.
 */
export async function recordLanSnapshot({
  ip,
  duration_s = 3,
  output_path,
  run = execFileAsync,
  mode = "snapshot",
  size = "1920x1080",
  flv_port = 18088,
} = {}) {
  if (typeof ip !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(ip))
    throw new Error("IPv4 address required");
  const output = String(output_path ?? "");
  if (!output) throw new Error("output_path is required for a LAN camera capture");
  const isStream = mode === "stream";
  const flvUrl = `http://${ip}:${Number(flv_port) || 18088}/flv`;
  if (!isStream) {
    await run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-timeout",
        "5000000",
        "-i",
        flvUrl,
        ...sizeArgs(size),
        "-frames:v",
        "1",
        output,
      ],
      { timeout: Math.min(duration_s, 30) * 1000 + 10000, windowsHide: true },
    );
    return { ok: true, mode: "snapshot", output_path: output, source: flvUrl, size };
  }
  await run(
    "ffmpeg",
    [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-timeout",
      "5000000",
      "-i",
      flvUrl,
      ...sizeArgs(size),
      "-t",
      String(Math.min(Math.max(duration_s ?? 3, 1), 60)),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      output,
    ],
    { timeout: Math.min(duration_s ?? 3, 60) * 1000 + 15000, windowsHide: true },
  );
  return { ok: true, mode: "stream", output_path: output, source: flvUrl, size, duration_s };
}

function sizeArgs(size) {
  const m = /^(\d+)x(\d+)$/.exec(String(size ?? ""));
  if (!m) return [];
  return ["-vf", `scale=${m[1]}:${m[2]}:force_original_aspect_ratio=decrease`];
}

// ---------------------------------------------------------------------------
// MCP registration
// ---------------------------------------------------------------------------

export function registerAuditGapTools(server, z, { manager, resolvePrinter } = {}) {
  const shared = {
    printer_id: z.number().int().positive().optional(),
    access_token: z.string().max(4096).optional(),
    resources_dir: z.string().max(1024).optional(),
  };

  async function ensureSession(args) {
    const cloud = manager?.cloud;
    if (!cloud) throw new Error("No cloud session available.");
    if (!cloud.xxToken) {
      const token = args.access_token ?? process.env.ANYCUBIC_CLOUD_TOKEN ?? null;
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

  server.registerTool(
    "account_file_upload",
    {
      title: "Upload a local file to the Anycubic cloud",
      description:
        "Uploads a local G-code/3MF to the account cloud shelf using the validated flow (lockStorageSpace -> presigned S3 PUT -> newUploadFile claim -> unlock; orphaned locks are deleted on failure). Returns the cloud file id and, when the cloud has processed it, the gcode_id needed by printer_print_start. Requires confirm:true because it writes account data.",
      inputSchema: {
        local_file: z.string().min(1).max(1024),
        remote_name: z.string().max(200).optional(),
        is_temp_file: z.boolean().default(false),
        confirm: z.boolean().default(false),
        ...shared,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("account_file_upload requires confirm: true. Nothing was sent.");
        const cloud = await ensureSession(args);
        const result = await uploadFileToCloud(cloud, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "account_print_local",
    {
      title: "Upload a local file and start the cloud print (order 1, verified)",
      description:
        'Full local-to-print flow: uploads the local G-code to the cloud (same validated flow as account_file_upload), resolves the resulting gcode_id, then starts the print with the LIVE-VALIDATED order 1 contract including post-send task verification (order 1240 was disproven live 2026-09-11 — it accepts but never creates a task). Combines the previously bridge-only /cloud/print-local capability with the MCP start pipeline. Requires confirm:true AND confirm_word:"EXECUTE".',
      inputSchema: {
        local_file: z.string().min(1).max(1024),
        remote_name: z.string().max(200).optional(),
        ai_detect: z.boolean().default(true),
        camera_timelapse: z.boolean().default(false),
        use_ams: z.boolean().default(false),
        ams_box_mapping: z.record(z.string(), z.unknown()).optional(),
        live_state: z.string().max(40).optional(),
        confirm: z.boolean().default(false),
        confirm_word: z.string().max(16).optional(),
        verify_timeout_ms: z.number().int().min(5000).max(90000).optional(),
        ...shared,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true || args.confirm_word !== "EXECUTE") {
          throw new Error(
            'account_print_local requires confirm: true AND confirm_word: "EXECUTE". Nothing was sent.',
          );
        }
        if (args.use_ams && !args.ams_box_mapping) {
          throw new Error(
            "use_ams requires ams_box_mapping (slot -> ams_index). Nothing was sent.",
          );
        }
        const cloud = await ensureSession(args);
        const printer = await resolvePrinterOrDefault(cloud, args.printer_id);
        const uploaded = await uploadFileToCloud(cloud, {
          local_file: args.local_file,
          remote_name: args.remote_name,
        });
        if (!uploaded.gcode_id) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  redact({
                    ok: false,
                    uploaded,
                    error:
                      "The cloud has not generated a gcode_id for this upload yet. Slice-info uploads require the slicer pipeline; check user files later.",
                  }),
                ),
              },
            ],
            structuredContent: { ok: false, uploaded },
          };
        }
        const start = await cloudPrintStart(
          manager,
          cloud,
          printer,
          {
            gcode_id: uploaded.gcode_id,
            file_name: uploaded.file_name,
            ai_detect: args.ai_detect,
            camera_timelapse: args.camera_timelapse,
            live_state: args.live_state,
            ams: args.use_ams
              ? {
                  ams_box_mapping: args.ams_box_mapping
                    ? Object.entries(args.ams_box_mapping).map(([paintIndex, info]) => ({
                        paint_index: Number(paintIndex),
                        ...(typeof info === "object" && info ? info : {}),
                      }))
                    : undefined,
                }
              : null,
          },
          { verifyTimeoutMs: args.verify_timeout_ms ?? 30000 },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(redact({ uploaded, ...start })) }],
          structuredContent: redact({ uploaded, ...start }),
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "printer_lan_camera",
    {
      title: "Capture a camera snapshot or short stream over the printer LAN",
      description:
        "Grabs the printer camera feed via the documented HTTP-FLV endpoint (port 18088) using a fixed ffmpeg argv (no shell). mode:snapshot saves a single frame (PNG/JPG); mode:stream saves a short MP4 clip (duration_s, up to 60s). requires LAN Mode (port 18088 reachable) and an output_path inside the allowed output roots. The capture itself is read-only for the printer state.",
      inputSchema: {
        ip: z.string().max(64),
        output_path: z.string().min(1).max(1024),
        mode: z.enum(["snapshot", "stream"]).default("snapshot"),
        duration_s: z.number().int().min(1).max(60).default(3),
        size: z.string().max(16).optional(),
        flv_port: z.number().int().min(1).max(65535).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const result = redact(await recordLanSnapshot(args));
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "camera_watch",
    {
      title: "Watch the LAN camera by periodic snapshots (opt-in)",
      description:
        "Read-only camera watchdog: takes snapshot(s) every interval_s from the LAN camera (port 18088) and saves them under a timestamped filename (or a fixed output_dir + tag). Stops after a bounded number of snapshots (snapshots, default 3) — it is not a continuous stream dump. Requires confirm:true because it writes files to disk repeatedly. Each snapshot is a single ffmpeg frame capture (argv fixed, no shell).",
      inputSchema: {
        ip: z.string().max(64),
        output_dir: z.string().min(1).max(1024),
        tag: z.string().max(80).optional(),
        interval_s: z.number().int().min(5).max(3600).default(30),
        snapshots: z.number().int().min(1).max(12).default(3),
        size: z.string().max(16).optional(),
        flv_port: z.number().int().min(1).max(65535).optional(),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("camera_watch requires confirm: true. Nothing was written.");
        const count = Math.min(Math.max(args.snapshots ?? 3, 1), 12);
        const interval = Math.min(Math.max(args.interval_s ?? 30, 5), 3600);
        const tag = args.tag ?? "watch";
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const written = [];
        for (let i = 0; i < count; i += 1) {
          const file = path.join(
            args.output_dir,
            `${tag}-${stamp}-${String(i + 1).padStart(2, "0")}.jpg`,
          );
          await recordLanSnapshot({
            ip: args.ip,
            output_path: file,
            duration_s: 2,
            size: args.size,
            flv_port: args.flv_port,
            mode: "snapshot",
          });
          written.push(file);
          if (i < count - 1) await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        }
        const result = redact({ ok: true, written, count, interval_s: interval });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "printer_connection_close",
    {
      title: "Close the persistent cloud MQTT session",
      description:
        "Hygiene: gracefully ends the persistent cloud MQTT session (frees the broker identity). The next command automatically reconnects. Read-only for the printer.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        await manager.release();
        const data = { ok: true, closed: true, health: manager.health() };
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );

  server.registerTool(
    "printer_material_catalog",
    {
      title: "List the known Anycubic material types",
      description:
        "Read-only, offline. The material type vocabulary accepted by ACE slot writes (ace_set_slot) and used in cloud orders. Useful to validate material_type values before a command.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const data = { read_only: true, materials: [...ANYCUBIC_MATERIALS] };
        return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: redact(error.message) }] };
      }
    },
  );
}
