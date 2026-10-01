import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * S9.5-003 printer discovery — pure core (parse/select/probe reducer) + lane
 * through fetchSceneSnapshot().discoverPrinters().
 *
 * AC: picker lists env-discovered printers (ANYCUBIC_PRINTER_IPS, comma list,
 * NO hardcoding — dedupe, trim, invalid-token rejection); selection arms the
 * send target; reachability folds tri-state LED state. The env value always
 * flows in from the caller — tests pass synthetic lists, never real IPs.
 */

const require_ = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadCore() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "state", "printers-core.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

async function loadMock() {
  const url = pathToFileURL(path.join(root, "apps", "editor", "src", "bridge", "mock.ts"));
  return import(`${url.href}?key=${Date.now()}`);
}

const corePromise = loadCore();
const mockPromise = loadMock();

test("printers-core: parses comma env list, dedupes, trims, rejects invalid", async () => {
  const core = await corePromise;
  const { ips, invalid } = core.parsePrinterIps(
    " 192.168.1.10 ,192.168.1.10,, 10.0.0.5 ,not-an-ip,fe80::1",
  );
  assert.deepEqual(ips, ["192.168.1.10", "10.0.0.5", "fe80::1"]);
  assert.deepEqual(invalid, ["not-an-ip"]);
});

test("printers-core: empty env yields no printers + actionable hint", async () => {
  const core = await corePromise;
  const s = core.initialPrintersState("");
  assert.deepEqual(s.printers, []);
  assert.equal(s.source, "env");
  assert.match(s.hint ?? "", /ANYCUBIC_PRINTER_IPS/);
  assert.equal(s.selectedId, null);
});

test("printers-core: invalid-only env hints at the bad tokens", async () => {
  const core = await corePromise;
  const s = core.initialPrintersState("bogus!!,  ,junk/ip");
  assert.deepEqual(s.printers, []);
  assert.match(s.hint ?? "", /Invalid entries/);
});

test("printers-core: initial list has tri-state reachable null + stable ids", async () => {
  const core = await corePromise;
  const s = core.initialPrintersState("192.168.1.10,10.0.0.5");
  assert.equal(s.printers.length, 2);
  assert.deepEqual(
    s.printers.map((p) => [p.ip, p.reachable, p.machineType, p.lastSeenAt]),
    [
      ["192.168.1.10", null, null, null],
      ["10.0.0.5", null, null, null],
    ],
  );
  assert.equal(s.printers[0]?.id, core.printerId("192.168.1.10"));
  assert.equal(s.printers[0]?.name, core.printerName("192.168.1.10"));
});

test("printers-core: probe-done folds reachability + lastSeenAt per printer", async () => {
  const core = await corePromise;
  let s = core.initialPrintersState("192.168.1.10,10.0.0.5");
  s = core.reducePrinters(s, { kind: "probe-start" }).state;
  const at = 1_700_000_000_000;
  s = core.reducePrinters(s, {
    kind: "probe-done",
    reachable: { [s.printers[0]?.id ?? ""]: true, [s.printers[1]?.id ?? ""]: false },
    at,
  }).state;
  assert.equal(s.probing, false);
  assert.equal(s.printers[0]?.reachable, true);
  assert.equal(s.printers[0]?.lastSeenAt, at);
  assert.equal(s.printers[1]?.reachable, false);
  assert.equal(s.printers[1]?.lastSeenAt, at);
});

test("printers-core: probe rejected while already probing; select only known ids", async () => {
  const core = await corePromise;
  let s = core.initialPrintersState("192.168.1.10");
  s = core.reducePrinters(s, { kind: "probe-start" }).state;
  const dup = core.reducePrinters(s, { kind: "probe-start" });
  assert.deepEqual(dup.rejected, ["probe already in flight"]);
  s = core.reducePrinters(s, { kind: "probe-done", reachable: {}, at: 1 }).state;
  // unknown id rejected
  const bad = core.reducePrinters(s, { kind: "select", id: "printer-unknown" });
  assert.notDeepEqual(bad.rejected, []);
  assert.ok(bad.rejected?.some((r) => r.includes("unknown printer")));
  // known id arms the send target
  const good = core.reducePrinters(s, { kind: "select", id: s.printers[0]?.id ?? "" });
  assert.equal(good.state.selectedId, s.printers[0]?.id ?? "");
  // clear selection
  const cleared = core.reducePrinters(good.state, { kind: "select", id: null });
  assert.equal(cleared.state.selectedId, null);
});

test("printers-core: probe-done during idle is rejected (no stale merge)", async () => {
  const core = await corePromise;
  const s = core.initialPrintersState("");
  const out = core.reducePrinters(s, { kind: "probe-done", reachable: {}, at: 1 });
  assert.deepEqual(out.rejected, ["no probe in flight"]);
  assert.deepEqual(out.state.printers, []);
});

test("printers core lane: discoverPrinters lists env printers without hardcoding", async () => {
  const mock = await mockPromise;
  const handle = await mock.fetchSceneSnapshot();
  const result = await handle.discoverPrinters("192.168.1.10,192.168.1.11");
  assert.equal(result.ok, true);
  assert.equal(result.source, "env");
  assert.equal(result.printers.length, 2);
  assert.equal(result.printers[0]?.ip, "192.168.1.10");
  assert.equal(result.printers[1]?.ip, "192.168.1.11");
  // identifiers derive from the IP literal, never a hardcoded secret
  assert.equal(result.printers[0]?.id, "printer-192-168-1-10");
  assert.equal(result.printers[0]?.reachable, null);
});

test("printers core lane: lane rejects invalid tokens silently (empty list)", async () => {
  const mock = await mockPromise;
  const handle = await mock.fetchSceneSnapshot();
  const result = await handle.discoverPrinters("bogus,, junk/ip");
  assert.equal(result.ok, true);
  assert.equal(result.printers.length, 0);
});
