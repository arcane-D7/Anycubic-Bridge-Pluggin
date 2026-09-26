import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function normalize(value) {
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(normalize);
  return value;
}

function runningSlicers() {
  const script =
    "Get-Process -Name AnycubicSlicerNext -ErrorAction SilentlyContinue | Select-Object Id,MainWindowTitle,MainWindowHandle | ConvertTo-Json -Compress";
  const raw = execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  ).trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    process_id: Number(item.Id),
    window_title: String(item.MainWindowTitle ?? ""),
    window_handle: Number(item.MainWindowHandle ?? 0),
  }));
}

function resolveProcess({ process_id, window_title } = {}) {
  const processes = runningSlicers();
  if (process_id) {
    const hit = processes.find((item) => item.process_id === process_id);
    if (!hit) throw new Error(`Anycubic Slicer process ${process_id} is not running`);
    return hit;
  }
  if (window_title) {
    const wanted = window_title.toLowerCase().replace(/[\s*+()]/g, "");
    const hit = processes.find((item) => {
      const actual = item.window_title.toLowerCase().replace(/[\s*+()]/g, "");
      return actual.includes(wanted) || wanted.includes(actual);
    });
    if (!hit) throw new Error(`No running Anycubic Slicer window matches '${window_title}'`);
    return hit;
  }
  const hit = processes.find((item) => item.window_handle !== 0) ?? processes[0];
  if (!hit) throw new Error("Anycubic Slicer Next is not running");
  return hit;
}

function sessionDirectories(processId) {
  const root = path.join(os.tmpdir(), "anycubicslicer_model");
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const date of fs.readdirSync(root, { withFileTypes: true })) {
    if (!date.isDirectory()) continue;
    const dateDir = path.join(root, date.name);
    for (const session of fs.readdirSync(dateDir, { withFileTypes: true })) {
      if (!session.isDirectory() || !session.name.includes(`#${processId}#`)) continue;
      const dir = path.join(dateDir, session.name);
      if (fs.existsSync(path.join(dir, "_temp_3.config"))) result.push(dir);
    }
  }
  return result.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function projectOrigin(sessionDir) {
  const origin = path.join(sessionDir, "origin.txt");
  return fs.existsSync(origin) ? fs.readFileSync(origin, "utf8").trim() : null;
}

function saveSessionConfig(configPath, settings) {
  const temp = `${configPath}.agent-${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 4)}\n`, "utf8");
  fs.renameSync(temp, configPath);
}

export function saveLiveSlicerProject(processId) {
  const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type @'
using System; using System.Runtime.InteropServices;
public static class WindowSaveApi { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); }
'@; $p=Get-Process -Id ${Number(processId)} -ErrorAction Stop; [WindowSaveApi]::ShowWindowAsync($p.MainWindowHandle,9)|Out-Null; [WindowSaveApi]::SetForegroundWindow($p.MainWindowHandle)|Out-Null; Start-Sleep -Milliseconds 250; [System.Windows.Forms.SendKeys]::SendWait('^s'); 'saved'`;
  execFileSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8" },
  );
  return true;
}

function setLayerHeightViaUi(processId, value) {
  const script = path.join(process.cwd(), "scripts", "set-live-field.ps1");
  execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-ProcessId",
      String(processId),
      "-X",
      "310",
      "-Y",
      "625",
      "-Value",
      String(value),
    ],
    { encoding: "utf8" },
  );
  return true;
}

export function applyLiveSlicerSettings({ process_id, window_title, settings, save = true }) {
  const process = resolveProcess({ process_id, window_title });
  const sessions = sessionDirectories(process.process_id);
  if (!sessions.length) {
    throw new Error(
      `No active Anycubic Slicer session state found for process ${process.process_id}`,
    );
  }
  const sessionDir = sessions[0];
  const configPath = path.join(sessionDir, "_temp_3.config");
  const before = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const applied = Object.fromEntries(
    Object.entries(settings ?? {})
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, normalize(value)]),
  );
  const after = { ...before, ...applied };
  saveSessionConfig(configPath, after);
  const saved = save ? saveLiveSlicerProject(process.process_id) : false;
  const uiLayerHeight = applied.layer_height
    ? setLayerHeightViaUi(process.process_id, applied.layer_height)
    : false;
  return {
    process_id: process.process_id,
    window_title: process.window_title,
    session_directory: sessionDir,
    project_origin: projectOrigin(sessionDir),
    settings_file: configPath,
    applied_settings: applied,
    before_settings: Object.fromEntries(Object.keys(applied).map((key) => [key, before[key]])),
    after_settings: Object.fromEntries(Object.keys(applied).map((key) => [key, after[key]])),
    direct_session_update: true,
    project_save_dispatched: saved,
    ui_layer_height_update: uiLayerHeight,
    geometry_touched: false,
  };
}
