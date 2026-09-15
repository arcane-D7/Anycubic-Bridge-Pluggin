// Clear residual print task on the device so a new START_PRINT (order 1)
// is accepted. Reason 10101 "Print task already exists" means the printer
// still tracks a previous task. sendOrder STOP_PRINT (order 4, int per ref)
// with the taskid of the failed task <TASK_ID>.
import { AnycubicCloud, findSlicerJwt } from "./anycubic-cloud.mjs";

const cloud = new AnycubicCloud({
  access_token: findSlicerJwt("%APPDATA%/AnycubicSlicerNext/log"),
  resources_dir: "<REPO_ROOT>\\resources",
  log: (m) => console.log("  " + m),
});
await cloud.login();
const printer = (await cloud.listPrinters())[0];
console.log(
  "[before]",
  JSON.stringify({
    is_printing: printer.is_printing,
    reason: printer.reason,
    ready_status: printer.ready_status,
  }),
);

// STOP_PRINT = 4 (int) with the residual project id + data.taskid
const body = {
  printer_id: printer.id,
  order_id: 4,
  project_id: <TASK_ID>,
  data: { taskid: "<TASK_ID>" },
  ams_info: null,
  settings: null,
};
console.log("[stop] body:", JSON.stringify(body));
const res = await cloud.rawApi("POST", "/work/operation/sendOrder", { params: body });
console.log("[stop] response:", JSON.stringify(res));

const client = await cloud.connectMqtt(printer, {
  onEvent: (e) => {
    const d = e.data;
    if (d?.type === "status" && d?.action === "workReport")
      console.log(`[w] state=${d.state} last=${d.last_project ? d.last_project.state : "null"}`);
  },
});
await new Promise((r) => setTimeout(r, 15000));
await client.endAsync(true).catch(() => {});
const p2 = (await cloud.listPrinters())[0];
console.log(
  "[after]",
  JSON.stringify({ is_printing: p2.is_printing, reason: p2.reason, ready_status: p2.ready_status }),
);
console.log("[done]");
process.exit(0);


