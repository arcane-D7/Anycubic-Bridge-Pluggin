// Monitor the print job live via MQTT: print/report progress, tempature, status.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: () => {},
});
await cloud.login();
const p = (await cloud.listPrinters())[0];
console.log(`monitoring ${p.name}...`);

let printState = null;
const client = await cloud.connectMqtt(p, {
  onEvent: e => {
    if (e.topic.startsWith("print")) {
      const d = e.data.data ?? e.data;
      if (d.progress !== undefined || d.state || d.curr_layer) {
        printState = d;
        console.log(`[print] progress=${d.progress}% layer=${d.curr_layer}/${d.total_layers} state=${d.state ?? "-"} remain=${d.remain_time ?? "-"}min`);
      }
    } else if (e.topic.startsWith("tempature")) {
      const t = e.data.data ?? e.data;
      console.log(`[temp] nozzle=${t.curr_nozzle_temp}/${t.target_nozzle_temp} bed=${t.curr_hotbed_temp}/${t.target_hotbed_temp}`);
    } else if (e.topic.startsWith("status")) {
      console.log(`[status] ${e.data.state}`);
    }
  },
});

// monitor — waits for print activity or completes after duration
const DURATION = Number(process.env.MONITOR_MS ?? 90000);
const t0 = Date.now();
while (Date.now() - t0 < DURATION) {
  await sleep(10000);
  if (printState && (printState.state === "finished" || printState.state === "stoped")) break;
}
client.end(true);
console.log(`monitor done. print activity: ${printState ? JSON.stringify(printState).slice(0, 200) : "none"}`);
process.exit(0);

