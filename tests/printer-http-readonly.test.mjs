import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readPrinterHttp,
  parseCurlReply,
  validatePrivateIPv4,
} from "../scripts/printer-http-readonly.mjs";
test("reject public IPs, URLs and shell fragments", () => {
  for (const ip of ["8.8.8.8", "http://192.168.3.110", "192.168.3.110;whoami", "192.168.999.1"])
    assert.throws(() => validatePrivateIPv4(ip));
});
test("parse status and redact credentials", () => {
  const r = parseCurlReply('{"apiKey":"secret"}\n__HTTP_STATUS__:200');
  assert.equal(r.status, 200);
  assert.equal(r.data.apiKey, "[redacted]");
});
test("GET endpoints stay isolated and cannot inject arbitrary paths", async () => {
  await assert.rejects(readPrinterHttp({ ip: "192.168.3.110", endpoints: ["restart"] }));
  const r = await readPrinterHttp({
    ip: "192.168.3.110",
    endpoints: ["version", "logs"],
    run: async (exe, args) => {
      assert.equal(exe, "curl.exe");
      assert.ok(!args.includes("--location"));
      if (args.at(-1).endsWith("/logs")) throw new Error("timeout");
      return { stdout: '{"server":"1.8.7"}\n__HTTP_STATUS__:200' };
    },
  });
  assert.equal(r.endpoints.version.state, "reply");
  assert.equal(r.endpoints.logs.state, "transport_error");
});
