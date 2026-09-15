/**
 * slicer-tools.mjs — MCP tools that drive the Anycubic Slicer Next native CLI
 * end-to-end (slice → export 3MF → validate firmware compatibility).
 *
 * This complements the fragile `slice_via_app` GUI/UIA path with a pure CLI
 * path proven on this machine (2026-09-14): `--slice 0 --export-3mf` with
 * cwd = the export directory produces the same 3MF (G-code + metadata +
 * thumbnails) the GUI produces, so firmware error 10115 does not apply.
 *
 * Tools:
 *   slicer_profiles  (read)   list machine/process/filament presets
 *   slicer_settings  (read)   dump resolved settings JSON (info)
 *   slicer_slice     (write)  slice + export 3MF/G-code with confirm
 *   slicer_export_3mf(write)  slice + export 3MF project (alias, confirm)
 *
 * All gated by confirm:true for write tools. Outputs are redacted of any
 * token-looking content (paths and args are plain; the profile files carry
 * no secrets by construction).
 */
import path from "node:path";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  analyzeMultimaterialGcode,
  buildFilamentIdsArg,
  buildSliceArgs,
  collectArtifacts,
  discoverSlicerExecutable,
  extractGcodeFrom3mf,
  inspectCompatibility,
  overlayMultiMaterialKeys,
  resolvePreset,
  resolvePresets,
  runSlicer,
} from "./slicer-cli.mjs";

function redactPlain(value) {
  return value; // no secrets in slicer CLI surface; kept for parity
}

export function registerSlicerTools(server, z) {
  const out = (data) => ({
    content: [{ type: "text", text: JSON.stringify(redactPlain(data)) }],
    structuredContent: redactPlain(data),
  });
  const fail = (error) => ({
    isError: true,
    content: [{ type: "text", text: redactPlain(error.message) }],
  });

  // ---- slicer_profiles ------------------------------------------------------
  server.registerTool(
    "slicer_profiles",
    {
      title: "List Anycubic slicer presets (machine/process/filament)",
      description:
        "Read-only. Lists the machine/process/filament profile files available in the installed Anycubic Slicer Next resources/profiles/Anycubic, optionally filtered by kind and/or a name substring. Helpful before choosing presets for slicer_slice.",
      inputSchema: {
        kind: z.enum(["machine", "process", "filament", "all"]).default("all"),
        query: z.string().max(120).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ kind, query }) => {
      try {
        const exe = discoverSlicerExecutable();
        if (!exe) throw new Error("Anycubic Slicer Next executable was not found.");
        const base = path.join(path.dirname(exe), "resources", "profiles", "Anycubic");
        const kinds = kind === "all" ? ["machine", "process", "filament"] : [kind];
        const profiles = [];
        for (const k of kinds) {
          const dir = path.join(base, k);
          if (!existsSync(dir)) continue;
          const names = readdirSync(dir)
            .filter((name) => name.toLowerCase().endsWith(".json"))
            .sort();
          for (const name of names) {
            if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
            profiles.push({
              kind: k,
              name: name.replace(/\.json$/i, ""),
              file: path.join(dir, name),
            });
          }
        }
        return out({ ok: true, count: profiles.length, profiles });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- slicer_settings ------------------------------------------------------
  server.registerTool(
    "slicer_settings",
    {
      title: "Dump resolved slicer settings (JSON)",
      description:
        "Read-only. Loads a machine + process profile into the slicer CLI and exports the resolved settings as JSON (--export-settings). Useful to inspect the effective profile before slicing. Requires the machine and process preset files (see slicer_profiles).",
      inputSchema: {
        machine_profile: z.string().min(1),
        process_profile: z.string().min(1),
        output_file: z.string().optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ machine_profile, process_profile, output_file }) => {
      const exe = discoverSlicerExecutable();
      if (!exe) throw new Error("Anycubic Slicer Next executable was not found.");
      const outputRoot =
        process.env.ANYCUBIC_CONTROL_OUTPUT_ROOT ??
        path.join(process.env.LOCALAPPDATA ?? "", "AnycubicSlicerNextControl");
      try {
        const presets = resolvePresets({
          slicerExe: exe,
          machine: machine_profile || undefined,
          process: process_profile || undefined,
        });
        const outName = output_file ? path.basename(output_file) : `settings-${Date.now()}.json`;
        const cwd = path.dirname(
          output_file ? path.resolve(output_file) : path.join(outputRoot, outName),
        );
        mkdirSync(cwd, { recursive: true });
        const args = [
          "--load-settings",
          presets.machine,
          "--load-settings",
          presets.process,
          "--export-settings",
          outName,
        ];
        const res = await runSlicer(exe, args, { cwd });
        if (res.exitCode !== 0) {
          return fail(
            new Error(
              `Slicer settings export failed (exit ${res.exitCode}): ${res.stderr.slice(0, 400)}`,
            ),
          );
        }
        const file = path.join(cwd, outName);
        if (!existsSync(file)) throw new Error(`Settings file not produced at ${file}`);
        const payload = JSON.parse(readFileSync(file, "utf8"));
        return out({
          ok: true,
          exit_code: res.exitCode,
          settings_file: file,
          machine_profile: path.basename(presets.machine),
          process_profile: path.basename(presets.process),
          settings: payload,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- slicer_slice ---------------------------------------------------------
  server.registerTool(
    "slicer_slice",
    {
      title: "Slice a model with the Anycubic slicer CLI and export 3MF/G-code",
      description:
        "Write (gated). Uses the installed Anycubic Slicer Next CLI (--slice + --export-3mf) to slice a .stl/.3mf into a firmware-compatible 3MF (same engine the GUI uses; no UIA). Accepts optional preset overrides (machine/process/filament by name), output directory, plate index, and returns the produced artifacts + firmware compatibility check. Requires confirm:true. The slicer CLI writes the 3MF into `output_dir` (default: the control output root) — pass `output_dir` explicitly to keep outputs predictable.",
      inputSchema: {
        input_file: z.string().min(1),
        machine: z.string().max(120).optional(),
        process: z.string().max(120).optional(),
        filament: z.string().max(120).optional(),
        output_dir: z.string().optional(),
        plate: z.number().int().min(0).max(64).default(0),
        export_format: z.enum(["gcode_3mf", "gcode"]).default("gcode_3mf"),
        output_name: z.string().max(180).optional(),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("slicer_slice requires confirm: true. Nothing was sliced.");
        const exe = discoverSlicerExecutable();
        if (!exe) throw new Error("Anycubic Slicer Next executable was not found.");
        const inputFile = path.resolve(args.input_file);
        if (!existsSync(inputFile)) throw new Error(`Input file not found: ${inputFile}`);
        const outputRoot = args.output_dir
          ? path.resolve(args.output_dir)
          : (process.env.ANYCUBIC_CONTROL_OUTPUT_ROOT ??
            path.join(process.env.LOCALAPPDATA ?? "", "AnycubicSlicerNextControl"));
        mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
        const presets = resolvePresets({
          slicerExe: exe,
          machine: args.machine ?? "",
          process: args.process ?? "",
          filament: args.filament ?? "",
        });
        if (!presets.machine || !presets.process)
          throw new Error(
            "Unable to resolve machine/process presets under the slicer installation.",
          );
        const { args: sliceArgs, cwd } = buildSliceArgs({
          slicerExe: exe,
          inputFile,
          presets,
          outputRoot,
          target3mf: args.output_name,
          slice: args.plate,
          type: args.export_format,
        });
        const res = await runSlicer(exe, sliceArgs, { cwd, timeoutMs: 6e5 });
        if (res.exitCode !== 0) {
          return fail(new Error(`Slicer exited ${res.exitCode}: ${res.stderr.slice(0, 500)}`));
        }
        const artifacts = collectArtifacts(cwd).map((file) => ({
          file,
          compatibility: inspectCompatibility(file),
        }));
        if (!artifacts.length) throw new Error("No artifacts produced by the slicer CLI.");
        return out({
          ok: true,
          exit_code: res.exitCode,
          output_dir: cwd,
          artifacts,
          next: [
            "Send the 3MF to the printer with send_to_printer, then start_print over LAN.",
            "Or upload via the cloud and use account_print (contract not fully validated).",
          ],
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- slicer_multimaterial ------------------------------------------------
  server.registerTool(
    "slicer_multimaterial",
    {
      title: "Slice with multi-material/flush-zero preset (marble mixing)",
      description:
        "Write (gated). Drives the Anycubic Slicer Next CLI to produce a multi-material slice WITHOUT relying on the GUI: (1) writes a temporary process preset into the user profile that maps roles (outer_wall/inner_wall/infill/top/bottom/support) to specific extruders and ZEROS all flush volumes (leaving intentional contamination for a marble/mixed-color surface), (2) loads N filaments + optional per-object filament ids (--load-filament-ids), (3) slices and exports 3MF, and (4) analyzes the resulting G-code for real tool switches (T0/T1...) and purge evidence, proving contamination is preserved. Requires confirm:true.",
      inputSchema: {
        input_file: z.string().min(1),
        machine: z.string().max(120).optional(),
        filaments: z.array(z.string().max(120)).min(1).max(8),
        filament_ids_per_object: z.array(z.number().int().min(1).max(16)).optional(),
        roles: z
          .object({
            outer_wall: z.string().regex(/^\d+$/).default("0"),
            inner_wall: z.string().regex(/^\d+$/).default("0"),
            infill: z.string().regex(/^\d+$/).default("0"),
            solid_infill: z.string().regex(/^\d+$/).default("0"),
            top_surface: z.string().regex(/^\d+$/).default("0"),
            bottom_surface: z.string().regex(/^\d+$/).default("0"),
            support: z.string().regex(/^\d+$/).default("0"),
            support_interface: z.string().regex(/^\d+$/).default("0"),
            flush_multiplier: z.string().regex(/^\d+$/).default("0"),
            printer_flush_multiplier: z.string().regex(/^\d+$/).default("0"),
            minimal_purge: z.string().regex(/^\d+$/).default("15"),
          })
          .optional(),
        output_dir: z.string().optional(),
        plate: z.number().int().min(0).max(64).default(0),
        output_name: z.string().max(180).optional(),
        analyze_gcode: z.boolean().default(true),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error(
            "slicer_multimaterial requires confirm: true. Nothing was sliced.",
          );
        const exe = discoverSlicerExecutable();
        if (!exe) throw new Error("Anycubic Slicer Next executable was not found.");
        const inputFile = path.resolve(args.input_file);
        if (!existsSync(inputFile)) throw new Error(`Input file not found: ${inputFile}`);

        const roles = args.roles ?? {};
        // Resolve the base process preset path from the system resources.
        // Default to the project's printer (Kobra S1 0.4) so the preset family
        // matching never falls back to a different machine (e.g. Kobra 1),
        // which would produce a "…Kobra 1…" process and abort exit -17.
        const machineName = args.machine ?? "Kobra S1 0.4";
        const machineFamily = machineName.includes("0.")
          ? machineName.replace(/\s+0\.\d+.*$/, "")
          : machineName;
        const baseDegree = args.process ?? "0.20mm Standard";
        const baseProcessMatch = baseDegree.includes("@Anycubic")
          ? baseDegree
          : `${baseDegree} @Anycubic ${machineFamily}`;
        const presets = resolvePresets({
          slicerExe: exe,
          machine: machineName,
          process: baseProcessMatch,
        });
        if (!presets.machine || !presets.process)
          throw new Error("Unable to resolve machine/process presets.");
        const baseProcess =
          JSON.parse(readFileSync(presets.process, "utf8"));
        const baseName = String(baseProcess.name ?? "0.20mm Standard");
        const mm = overlayMultiMaterialKeys(baseProcess, roles);
        mm.type = "process";
        // Keep the standard "…Kobra S1 0.4 nozzle" family so the CLI matches
        // this temporary preset against the machine; a custom display name
        // (e.g. "MarbleMix CLI") breaks preset-family matching and the slicer
        // aborts with exit -17 ("process not compatible").
        mm.name = baseName.replace(" Standard", " Standard MM");

        // Temporary preset in the USER profile (never touches system resources,
        // removed by runSlicer's promise cleanup below).
        const userProcessDir = path.join(
          process.env.APPDATA ?? "",
          "AnycubicSlicerNext",
          "user",
          "834765",
          "process",
        );
        mkdirSync(userProcessDir, { recursive: true });
        const tmpPreset = path.join(
          userProcessDir,
          `${baseName.replace(" Standard", " Standard MM")}.json`,
        );
        writeFileSync(tmpPreset, JSON.stringify(mm, null, 2), "utf8");
        let cleaned = false;
        const cleanUp = () => {
          if (!cleaned) {
            cleaned = true;
            try {
              if (existsSync(tmpPreset)) rmSync(tmpPreset, { force: true });
            } catch {
              /* best effort */
            }
          }
        };

        const outputRoot = args.output_dir
          ? path.resolve(args.output_dir)
          : (process.env.ANYCUBIC_CONTROL_OUTPUT_ROOT ??
            path.join(process.env.LOCALAPPDATA ?? "", "AnycubicSlicerNextControl"));
        mkdirSync(outputRoot, { recursive: true, mode: 0o700 });

        // Filament files must all resolve.
        const filaments = (args.filaments ?? []).map((name) => {
          const filDir = path.join(
            path.dirname(exe),
            "resources",
            "profiles",
            "Anycubic",
            "filament",
          );
          const f = resolvePreset(filDir, name) ?? resolvePreset(filDir, "");
          if (!f) throw new Error(`Filament preset not found for "${name}"`);
          return f;
        });

        // Build argv: machine + process (user temp) + filaments + optional ids
        const base = buildSliceArgs({
          slicerExe: exe,
          inputFile,
          presets: { machine: presets.machine, process: tmpPreset },
          outputRoot,
          target3mf: args.output_name,
          slice: args.plate,
          type: "gcode_3mf",
        });
        const argv = [];
        argv.push("--load-settings", presets.machine, "--load-settings", tmpPreset);
        if (filaments.length) argv.push("--load-filaments", filaments.join(";"));
        if (args.filament_ids_per_object?.length) {
          argv.push(
            "--load-filament-ids",
            buildFilamentIdsArg(args.filament_ids_per_object),
          );
        }
        // Copy the tail of base.args (--slice ... --export-3mf ... input) but
        // drop the leading --load-settings / --load-settings <machine/process>,
        // and use the ABSOLUTE input path (the CLI runs with cwd=outputRoot).
        const firstSlice = base.args.indexOf("--slice");
        const tailStart = firstSlice === -1 ? 0 : firstSlice;
        const tail = base.args.slice(tailStart);
        const inputIdx = tail.indexOf(inputFile);
        if (inputIdx !== -1) tail[inputIdx] = path.resolve(inputFile);
        argv.push(...tail);

        const res = await runSlicer(exe, argv, { cwd: base.cwd, timeoutMs: 6e5 });
        cleanUp();
        if (res.exitCode !== 0) {
          return fail(
            new Error(`Slicer exited ${res.exitCode}: ${res.stderr.slice(0, 500)}`),
          );
        }
        const artifacts = collectArtifacts(base.cwd).map((file) => ({
          file,
          compatibility: inspectCompatibility(file),
        }));
        if (!artifacts.length) throw new Error("No artifacts produced by the slicer CLI.");

        // Best-effort G-code analysis.
        let gcode_analysis = null;
        if (args.analyze_gcode) {
          const gcode = await extractGcodeFrom3mf(artifacts[0].file);
          if (gcode) gcode_analysis = analyzeMultimaterialGcode(gcode);
        }

        return out({
          ok: true,
          exit_code: res.exitCode,
          output_dir: base.cwd,
          artifacts,
          gcode_analysis,
          used_roles: roles,
          note:
            "flush_volumes_matrix/vector and flush multipliers are zeroed — tool changes leave intentional contamination (marble mixing).",
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- slicer_export_3mf (alias for slicer_slice, project export) -----------
  server.registerTool(
    "slicer_export_3mf",
    {
      title: "Slice and export a project 3MF (alias)",
      description:
        "Write (gated). Same engine as slicer_slice but always exports the project as a 3MF (gcode_3mf). Provided for CLI parity; requires confirm:true.",
      inputSchema: {
        input_file: z.string().min(1),
        machine: z.string().max(120).optional(),
        process: z.string().max(120).optional(),
        filament: z.string().max(120).optional(),
        output_dir: z.string().optional(),
        plate: z.number().int().min(0).max(64).default(0),
        output_name: z.string().max(180).optional(),
        confirm: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        if (args.confirm !== true)
          throw new Error("slicer_export_3mf requires confirm: true. Nothing was exported.");
        const exe = discoverSlicerExecutable();
        if (!exe) throw new Error("Anycubic Slicer Next executable was not found.");
        const inputFile = path.resolve(args.input_file);
        if (!existsSync(inputFile)) throw new Error(`Input file not found: ${inputFile}`);
        const outputRoot = args.output_dir
          ? path.resolve(args.output_dir)
          : (process.env.ANYCUBIC_CONTROL_OUTPUT_ROOT ??
            path.join(process.env.LOCALAPPDATA ?? "", "AnycubicSlicerNextControl"));
        mkdirSync(outputRoot, { recursive: true });
        const presets = resolvePresets({
          slicerExe: exe,
          machine: args.machine ?? "",
          process: args.process ?? "",
          filament: args.filament ?? "",
        });
        const { args: sliceArgs, cwd } = buildSliceArgs({
          slicerExe: exe,
          inputFile,
          presets,
          outputRoot,
          target3mf: args.output_name,
          slice: args.plate,
          type: "gcode_3mf",
        });
        const res = await runSlicer(exe, sliceArgs, { cwd, timeoutMs: 6e5 });
        if (res.exitCode !== 0)
          return fail(new Error(`Slicer exited ${res.exitCode}: ${res.stderr.slice(0, 500)}`));
        const artifacts = collectArtifacts(cwd).map((file) => ({
          file,
          compatibility: inspectCompatibility(file),
        }));
        return out({ ok: true, exit_code: res.exitCode, output_dir: cwd, artifacts });
      } catch (error) {
        return fail(error);
      }
    },
  );

  // ---- slicer_project_state ------------------------------------------------
  server.registerTool(
    "slicer_project_state",
    {
      title: "Inspect an open/listed slicer project in full (objects, configs)",
      description:
        "Read-only. Locates a project (by window title, by recent project entry, or by explicit path) in the Anycubic Slicer Next data dir, then parses the matching .3MF to report: objects and their meshes, plates, project_settings.config (599 keys) and process_settings_*.config (332 keys) with the print-relevant keys (layer height, walls, infill, support, speeds, temperatures, filaments/colors), plus per-plate bounding box. Gives full visibility into what any open slicer window has loaded — no guessing.",
      inputSchema: {
        window_title: z.string().max(160).optional(),
        recent_index: z.number().int().min(1).max(99).optional(),
        project_path: z.string().min(1).max(1024).optional(),
        include_full_config: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        const configPath = path.join(
          process.env.APPDATA ?? "",
          "AnycubicSlicerNext",
          "AnycubicSlicerNext.conf",
        );
        const conf = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
        const recentProjects = [];
        const mRec = conf.match(/"recent_projects"\s*:\s*\{([\s\S]*?)\n\s*\}/);
        if (mRec) {
          const reKey = /"(\d{2})"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
          let mm;
          while ((mm = reKey.exec(mRec[1]))) recentProjects.push({ idx: mm[1], path: mm[2] });
        }
        // Resolve the .3MF to inspect.
        let target = args.project_path ?? null;
        if (!target && args.recent_index) {
          const hit = recentProjects.find((r) => Number(r.idx) === args.recent_index);
          if (hit) target = hit.path;
        }
        if (!target && args.window_title) {
          const clean = args.window_title.replace(/[*+]/g, " ").replace(/\(.*?\)/g, "").trim().toLowerCase().replace(/\s+/g, "");
          const hit = recentProjects.find((r) => {
            const bn = path.basename(r.path, ".3mf").toLowerCase().replace(/[*+]/g, "").replace(/\s+/g, "");
            return bn.includes(clean) || clean.includes(bn);
          });
          if (hit) target = hit.path;
        }
        if (!target) {
          return out({
            ok: false,
            hint:
              "No project resolved. Pass project_path, recent_index (1-18), or window_title matching a recent project.",
            recent_projects: recentProjects.map((r) => ({ idx: r.idx, name: path.basename(r.path) })),
          });
        }
        const { read3mf } = await import("./read-3mf.mjs");
        const files = read3mf(target);
        const textOf = (name) => {
          const f = files.find((x) => x.name === name);
          return f ? f.data.toString("utf8") : null;
        };
        const fileBytes = (() => {
          try { return statSync(target).size; } catch { return null; }
        })();
        const jsonOf = (name) => {
          const t = textOf(name);
          if (!t) return null;
          try { return JSON.parse(t); } catch { return null; }
        };
        // Plates metadata first (object block uses friendly names from here).
        const plates = [];
        for (const f of files) {
          const pm = /^Metadata\/plate_(\d+)\.json$/.exec(f.name);
          if (pm) {
            let bbox = null;
            try { bbox = JSON.parse(f.data.toString("utf8")); } catch {}
            plates.push({ plate: pm[1], bbox });
          }
        }
        // Objects from the 3MF model (object id -> components with mesh paths).
        const model = textOf("3D/3dmodel.model");
        const objects = [];
        if (model) {
          const reObj = /<object\s+id="(\d+)"[^>]*type="([^"]*)"[^>]*>([\s\S]*?)<\/object>/g;
          let mo;
          while ((mo = reObj.exec(model))) {
            const id = mo[1];
            const type = mo[2] || "model";
            const body = mo[3];
            const components = [];
            const reComp = /<component\s+[^>]*p:path="([^"]+)"[^>]*>/g;
            let mc;
            while ((mc = reComp.exec(body))) {
              const realPath = mc[1].replace(/^\//, "");
              const meshName = realPath.split("/").pop();
              const meshFile = files.find((x) => x.name === realPath);
              let vertices = 0;
              let triangles = 0;
              if (meshFile) {
                let ms;
                try { ms = meshFile.data.toString("utf8"); } catch { ms = ""; }
                vertices = (ms.match(/<vertex\s[^>]*>/g) || []).length;
                triangles = (ms.match(/<triangle\s[^>]*>/g) || []).length;
              }
              components.push({ mesh: meshName, vertices, triangles });
            }
            objects.push({ id, type, components, total_vertices: components.reduce((a, c) => a + c.vertices, 0), total_triangles: components.reduce((a, c) => a + c.triangles, 0) });
          }
          // Prefer friendly names from plate bbox_objects when objects have no Title metadata.
          const plateNames = [];
          for (const p of plates) {
            for (const b of p.bbox?.bbox_objects ?? []) {
              if (b.name && !plateNames.includes(b.name)) plateNames.push(b.name);
            }
          }
          if (objects.length === 0 || objects.every((o) => o.components.length === 0)) {
            objects.push(...plateNames.map((n) => ({ id: "plate", type: "model", components: [{ mesh: n, vertices: 0, triangles: 0 }], total_vertices: 0, total_triangles: 0 })));
          }
        }
        const projectCfg = jsonOf("Metadata/project_settings.config");
        const processCfg = jsonOf("Metadata/process_settings_1.config");
        const pickKeys = (cfg, keys) => {
          if (!cfg) return {};
          const red = {};
          for (const k of keys) if (k in cfg) red[k] = cfg[k];
          return red;
        };
        const PRINT_KEYS = [
          "layer_height", "initial_layer_print_height", "wall_loops", "top_shell_layers",
          "bottom_shell_layers", "sparse_infill_density", "sparse_infill_pattern",
          "print_sequence", "brim_type", "brim_width", "enable_support", "support_type",
          "support_interface_pattern", "tree_support_branch_diameter", "nozzle_temperature",
          "initial_layer_print_temperature", "bed_temperature", "filament_colour",
          "filament_type", "outer_wall_speed", "inner_wall_speed", "sparse_infill_speed",
          "top_surface_speed", "travel_speed", "elefant_foot_compensation",
          "xy_hole_compensation", "z_offset",
        ];
        const summary = {
          ok: true,
          project: target,
          name: path.basename(target),
          size_bytes: fileBytes,
          objects,
          plates,
          config: {
            process: pickKeys(processCfg, PRINT_KEYS),
            project: pickKeys(projectCfg, PRINT_KEYS),
          },
          full_config_included: !!args.include_full_config,
        };
        if (args.include_full_config) {
          summary.config.process_full = processCfg;
          summary.config.project_full = projectCfg;
        }
        return out(summary);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
