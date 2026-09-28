// Integration harness — Sprint 5, S5-006.
// Wires broker <=> engine <=> MCP tool registration WITHOUT a live printer:
// all network fakes/stubs. Proves the new workspace's registry contract
// (capability names -> tool adapters) is testable headless.
//
// NOTE: The Tauri/Rust broker crate does not exist yet (Sprint 6). This test
// validates the CONTRACT via a JS double that mirrors the Rust broker's
// surface: registerTools(capabilities) + dispatch(toolName, args). The Rust
// broker must keep this contract in Sprint 6.
import assert from "node:assert/strict";

// --- Fake broker double (mirrors the Sprint 6 Rust broker trait) ----------
function createBrokerDouble() {
  const capabilities = new Map();
  const registry = new Map();

  return {
    // broker <- engine: engine declares named capabilities (geometry, mesh...)
    declareCapability(name, handler) {
      capabilities.set(name, handler);
    },
    // tool adapters register against capability NAMES, not implementations
    registerTools(defs) {
      for (const def of defs) {
        assert.ok(
          capabilities.has(def.requires),
          `tool ${def.name} requires undeclared capability ${def.requires}`,
        );
        registry.set(def.name, def);
      }
    },
    // dispatch: adapter calls the capability by name (DIP: no direct engine import)
    async dispatch(toolName, args) {
      const def = registry.get(toolName);
      if (!def) throw new Error(`unknown tool ${toolName}`);
      return def.handler(args, def.requires);
    },
    listTools() {
      return [...registry.keys()];
    },
  };
}

// --- Wire broker <=> engine <=> MCP adapters ------------------------------
async function main() {
  const broker = createBrokerDouble();

  // engine (geometry kernel — pure, no printer)
  const geometryEngine = {
    cylinder(radius, height) {
      return { shape: "cylinder", radius, height, volume: Math.PI * radius * radius * height };
    },
  };

  broker.declareCapability("geometry.kernel", (op) => {
    if (op.kind === "cylinder") return geometryEngine.cylinder(op.radius, op.height);
    throw new Error(`unknown geometry op ${op.kind}`);
  });

  // MCP tool adapters — thin, depend on capability names (ISP via capability interface)
  broker.registerTools([
    {
      name: "cad_test_cylinder",
      requires: "geometry.kernel",
      handler: (args) => ({
        ok: true,
        mesh: args.kind,
        shape: geometryEngine.cylinder(args.radius, args.height),
      }),
    },
  ]);

  const tools = broker.listTools();
  assert.deepEqual(tools, ["cad_test_cylinder"]);

  const res = await broker.dispatch("cad_test_cylinder", {
    kind: "cylinder",
    radius: 2,
    height: 3,
  });
  assert.equal(res.shape.volume, Math.PI * 4 * 3);

  // Unknown capability must be rejected at registration time (fail-closed).
  assert.throws(() => {
    broker.registerTools([{ name: "bad", requires: "printer.motion", handler: () => ({}) }]);
  }, /undeclared capability/);

  console.log("integration: OK — broker <=> engine <=> MCP tool registration (no live printer)");
}

await main();
