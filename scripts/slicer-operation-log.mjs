import fs from "node:fs";
import path from "node:path";

function logPath() {
  const root = process.env.PLUGIN_DATA ?? process.env.LOCALAPPDATA ?? process.cwd();
  return path.join(root, "AnycubicSlicerNextControl", "slicer-operations.jsonl");
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/token|secret|password|access_code|key/i.test(key)) return [key, "[redacted]"];
      return [key, sanitize(item)];
    }),
  );
}

export function appendSlicerOperation(event) {
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...sanitize(event) })}\n`,
    "utf8",
  );
  return file;
}

export function readSlicerOperations({ limit = 50, operation } = {}) {
  const file = logPath();
  if (!fs.existsSync(file)) return { file, operations: [] };
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const operations = lines
    .slice(-Math.min(Math.max(limit, 1), 500))
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean)
    .filter((item) => !operation || item.operation === operation);
  return { file, operations };
}
