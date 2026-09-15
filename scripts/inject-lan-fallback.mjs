// Injects a LAN-fallback branch into /cloud/devices of bridge-server.mjs.
// When the cloud account has no printers (LAN Mode active), the bridge exposes
// the LAN printer as a virtual cloud device so Orca's printer-agent can see it.
import fs from "node:fs";

const p = "<REPO_ROOT>/dist/bridge-server.mjs";
let src = fs.readFileSync(p, "utf8");

const marker = 'if (req.method === "GET" && url.pathname === "/cloud/devices") {';
const i = src.indexOf(marker);
if (i < 0) {
  console.error("marker not found — bridge format changed");
  process.exit(1);
}
if (src.includes("lan_fallback")) {
  console.log("already injected");
  process.exit(0);
}

const inject = `if (req.method === "GET" && url.pathname === "/cloud/devices" && url.searchParams.get("lan_fallback") === "1") {
        const lanIp = url.searchParams.get("ip") || options?.lanIp || this.lanIp || "127.0.0.1";
        try {
          const lanStatus = await this.lanStatus(lanIp, options?.timeoutMs ?? 20000);
          const st = lanStatus?.status ?? {};
          const devId = st.mqtt_device_id || st.dev_id || "lan-fallback";
          const online = Boolean(st.online);
          const model = st.model_name || "Anycubic Kobra S1";
          return sendJson(res, 200, {
            ok: true,
            printer: { id: devId, name: model + " (LAN)", model, online, connection: "LAN Mode via local proxy", local_address: "127.0.0.1", local_port: this.localPort, printer_agent_transport: "loopback" },
            devices: [{ id: devId, name: model + " (LAN)", model, online, deviceStatus: online ? 1 : 0 }],
            source: "lan_fallback"
          });
        } catch (error) {
          return sendJson(res, 200, { ok: true, printer: null, devices: [], source: "lan_fallback_error", error: String(error?.message ?? error) });
        }
      }
      `;

src = src.slice(0, i) + inject + src.slice(i);
fs.writeFileSync(p, src);
console.log("injected OK");
