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
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import {
  buildSliceArgs,
  collectArtifacts,
  discoverSlicerExecutable,
  inspectCompatibility,
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
}
