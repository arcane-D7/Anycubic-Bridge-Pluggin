/**
 * diagnose.mjs — diagnóstico read-only consolidado (substitui os probe-*.mjs).
 *
 * Cobre os 3 transports num único comando:
 *   --cloud    leituras via cloud (HTTP getPrinters + MQTT report)  [default]
 *   --lan <ip> handshake LAN nativo (18910) + leituras MQTT local (9883)
 *   --http     full HTTP read do cloud (read orders 1214/1231/1232/1206/103/101)
 *   --printers só lista as impressoras da conta cloud
 * Tudo é READ-ONLY: nunca envia comando, nunca move/heats/aquece.
 *
 * Uso: node scripts/diagnose.mjs [--cloud|--lan <ip>|--http|--printers] [--out <json>]
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import { redact, collectCloudReadings } from "./cloud-readonly-diagnostics.mjs";
import {
  lanHandshake,
  collectLanReadings,
  collectFullHttpReadings,
  collectFullReadings,
  collectCloudAccountReadings,
} from "./printer-full-read.mjs";

async function resolveCloud() {
  const accessToken = await findSlicerJwt();
  if (!accessToken) throw new Error("Slicer token não encontrado — execute a tool auth_setup / auth_id_flow_start primeiro.");
  return new AnycubicCloud({ accessToken });
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
  const mode =
    args.includes("--lan") ? "lan"
    : args.includes("--http") ? "http"
    : args.includes("--printers") ? "printers"
    : "cloud";
  const lanIp = args[args.indexOf("--lan") + 1];

  const cloud = await resolveCloud();
  const report = { mode, ts: new Date().toISOString() };

  if (mode === "printers") {
    const devices = await cloud.getPrinters({ timeoutMs: 20000 });
    report.devices = devices.map((d) => ({
      key: redact(d.key ?? d.id),
      name: d.name,
      model: d.modelId ?? d.type,
      online: d.deviceStatus ?? d.status,
    }));
  } else if (mode === "lan") {
    if (!lanIp || !/^\d{1,3}(\.\d{1,3}){3}$/.test(lanIp))
      throw new Error("--lan requer um IPv4 válido (ex: --lan <LAN_IP>)");
    const handshake = await lanHandshake(lanIp, 6000);
    report.handshake = { ok: true, brokerHost: redact(handshake.brokerHost), deviceId: redact(handshake.deviceId), modelId: handshake.modelId, serial: redact(handshake.serial) };
    report.readings = await collectLanReadings({ ip: lanIp, timeoutMs: 15000 });
  } else if (mode === "http") {
    const devices = await cloud.getPrinters({ timeoutMs: 20000 });
    const printer = devices[0];
    if (!printer) throw new Error("Nenhuma impressora na conta.");
    report.http = await collectFullHttpReadings(cloud, { printerId: printer.id ?? printer.key });
  } else {
    const devices = await cloud.getPrinters({ timeoutMs: 20000 });
    const printer = devices[0];
    const deviceId = printer?.id ?? printer?.key;
    report.device = redact(String(deviceId ?? "unknown"));
    report.cloud = await collectCloudReadings({ printerId: deviceId, timeoutMs: 20000 });
    report.account = await collectCloudAccountReadings(cloud).catch(() => null);
    if (printer) {
      report.full = await collectFullReadings(cloud, { printer }).catch(() => null);
    }
  }

  const safe = redact(report);
  const text = JSON.stringify(safe, null, 2);
  if (outFile) fs.writeFileSync(outFile, text);
  else console.log(text);
}

main().catch((error) => {
  console.error("diagnose:", error instanceof Error ? error.message : error);
  process.exit(1);
});
