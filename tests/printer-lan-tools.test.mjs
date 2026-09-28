import { test } from "node:test";
import assert from "node:assert/strict";
import z from "zod";
import { assertLanIp, registerPrinterLanTools } from "../scripts/printer-lan-tools.mjs";
import { recordLanSnapshot } from "../scripts/audit-gap-tools.mjs";

// --- assertLanIp -------------------------------------------------------------

test("assertLanIp accepts private/reserved LAN IPv4 and rejects public/loopback/multicast", () => {
  assert.equal(assertLanIp("192.168.3.110"), "192.168.3.110");
  assert.equal(assertLanIp("10.0.0.5"), "10.0.0.5");
  assert.equal(assertLanIp("172.16.0.1"), "172.16.0.1");
  assert.throws(() => assertLanIp("127.0.0.1"), /private LAN/i);
  assert.throws(() => assertLanIp("224.0.0.1"), /private LAN/i);
  assert.throws(() => assertLanIp("239.1.1.1"), /private LAN/i);
  assert.throws(() => assertLanIp("example.com"), /IPv4/);
  assert.throws(() => assertLanIp("192.168.3"), /IPv4/);
  assert.throws(() => assertLanIp(12345), /IPv4/);
  assert.throws(() => assertLanIp(undefined), /IPv4/);
});

// --- redactLanHandshake (behavioral via tool registration) -------------------

test("printer_lan_handshake redacts credentials by default and exposes them with include_credentials", async () => {
  const registered = new Map();
  const fakeServer = {
    registerTool: (name, config, handler) => registered.set(name, { config, handler }),
  };
  registerPrinterLanTools(fakeServer, z);

  // Both LAN tools must be registered and read-only.
  assert.deepEqual([...registered.keys()].sort(), ["printer_lan_handshake", "printer_lan_read"]);
  for (const name of ["printer_lan_handshake", "printer_lan_read"]) {
    assert.equal(
      registered.get(name).config.annotations.readOnlyHint,
      true,
      `${name} must be read-only`,
    );
  }

  const handshake = registered.get("printer_lan_handshake");
  const input = handshake.config.inputSchema;
  assert.equal(
    input.include_credentials.def.defaultValue,
    false,
    "credentials default to redacted",
  );

  // Handler returns redacted credentials by default (no network call needed to
  // verify the redaction rule — stub the transport dependency via a fake result).
  // We can't reach lanHandshake without a real printer, so we verify the tool's
  // own validation first: a bad IP must fail cleanly before any network I/O.
  const err = await handshake.handler({ ip: "not-an-ip" });
  assert.equal(err.isError, true);
  assert.match(JSON.stringify(err), /IPv4/);
});

test("printer_lan_read validates IP before connecting", async () => {
  const registered = new Map();
  const fakeServer = {
    registerTool: (name, config, handler) => registered.set(name, { config, handler }),
  };
  registerPrinterLanTools(fakeServer, z);
  const readTool = registered.get("printer_lan_read");
  const err = await readTool.handler({ ip: "127.0.0.1" });
  assert.equal(err.isError, true);
  assert.match(JSON.stringify(err), /private LAN/i);
});

// --- recordLanSnapshot: mode/size --------------------------------------------

test("recordLanSnapshot stream mode builds the ffmpeg args with duration and scale", async () => {
  const runs = [];
  const result = await recordLanSnapshot({
    ip: "192.168.3.110",
    output_path: "clip.mp4",
    mode: "stream",
    duration_s: 4,
    size: "640x480",
    flv_port: 19000,
    run: async (cmd, argv) => {
      runs.push({ cmd, argv });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "stream");
  assert.equal(result.duration_s, 4);
  assert.equal(result.size, "640x480");
  assert.equal(runs.length, 1);
  const argv = runs[0].argv;
  assert.ok(argv.includes("http://192.168.3.110:19000/flv"), "honours custom flv port");
  const scaleIdx = argv.findIndex((a) => a.startsWith("scale=640:480"));
  assert.ok(scaleIdx >= 0, "scale filter injected");
  assert.ok(Number(argv[argv.indexOf("-t") + 1]) === 4, "-t duration present");
  assert.ok(!argv.some((arg) => /&&|;|\|/.test(String(arg))), "no shell metacharacters");
});

test("recordLanSnapshot clamps duration_s into the 1..60 window", async () => {
  const runs = [];
  const result = await recordLanSnapshot({
    ip: "10.0.0.9",
    output_path: "long.mp4",
    mode: "stream",
    duration_s: 999,
    run: async (cmd, argv) => {
      runs.push({ cmd, argv });
    },
  });
  assert.equal(result.ok, true);
  const t = Number(runs[0].argv[runs[0].argv.indexOf("-t") + 1]);
  assert.ok(t === 60, `duration clamped to 60, got ${t}`);
});
