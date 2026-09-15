import { AnycubicCloud, findSlicerJwt, ORDER } from "./anycubic-cloud.mjs";
const cloud = new AnycubicCloud({
  access_token: findSlicerJwt(process.env.APPDATA + "/AnycubicSlicerNext/log"),
  resources_dir: new URL("../resources", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
  log: console.error,
});
await cloud.login();
const printer = (await cloud.listPrinters()).find(
  (p) => p.id === Number(process.env.ANYCUBIC_PRINTER_ID ?? 0),
);
if (!printer) throw new Error("Expected printer missing");
const client = await cloud.connectMqtt(printer, {
  onEvent: (e) => console.log(JSON.stringify({ topic: e.topic, data: e.data })),
});
try {
  await new Promise((r) => setTimeout(r, 1000));
  for (const type of [
    "axis",
    "peripherie",
    "info",
    "print",
    "tempature",
    "aiSettings",
    "extfilbox",
    "multiColorBox",
  ]) {
    await cloud.publishCommand(
      printer,
      type,
      type === "multiColorBox" ? "getInfo" : "query",
      {},
      client,
    );
  }
  await new Promise((r) => setTimeout(r, 20000));
} finally {
  client.end(true);
}
