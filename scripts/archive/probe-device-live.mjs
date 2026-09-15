import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";
import { CloudConnectionManager } from "./printer-command-bus.mjs";

const c = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log("  " + m),
});
await c.login();
const p = (await c.listPrinters())[0];
const cm = new CloudConnectionManager({ cloud: c, log: (m) => console.log("  [cm] " + m) });
const client = await cm.acquire(p);
// Query temperatures + status to see if device responds
for (const [id, args] of [
  ["temperature_set", { nozzle: 0, bed: 0 }],
  ["print_query", {}],
]) {
  const cmd = {
    type: id === "temperature_set" ? "tempature" : "print",
    action: id === "temperature_set" ? "query" : "query",
  };
  const topic = `anycubic/anycubicCloud/v1/pc/printer/${p.machine_type}/${p.key}/${cmd.type}`;
  const msgid = crypto.randomUUID();
  await new Promise((resolve, reject) =>
    client.publish(
      topic,
      JSON.stringify({
        type: cmd.type,
        action: cmd.action,
        timestamp: Date.now(),
        msgid,
        data: args,
      }),
      (e) => (e ? reject(e) : resolve()),
    ),
  );
  console.log(`[probe] ${cmd.type}/${cmd.action} msgid=${msgid}`);
}
console.log("[probe] waiting 12s for replies...");
await new Promise((r) => setTimeout(r, 12000));
for (const e of cm.events.slice(-12)) {
  const d = e.data;
  console.log(
    `[evt] ${e.topic.split("/").pop()} action=${d?.action} state=${d?.state} code=${d?.code} data=${JSON.stringify(d?.data)?.slice?.(0, 200)}`,
  );
}
await cm.release();
process.exit(0);
