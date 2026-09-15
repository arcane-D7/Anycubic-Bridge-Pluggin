import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptsDir, "..");
const transport = new StdioClientTransport({
  command: process.execPath,
  stderr: "pipe",
  args: [path.join(pluginRoot, "dist", "server.mjs")],
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
const client = new Client({ name: "anycubic-control-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.ok(listed.tools.every((tool) => tool.inputSchema && tool.annotations));
  assert.ok(listed.tools.length >= 79, `expected >= 79 tools, got ${listed.tools.length}`);
  assert.deepEqual(names, [
    "account_capture_token",
    "account_cloud_diagnostics",
    "account_cloud_files",
    "account_cloud_live_diagnostics",
    "account_cloud_projects",
    "account_cloud_store",
    "account_devices",
    "account_file_upload",
    "account_files",
    "account_login",
    "account_print",
    "account_print_history",
    "account_print_local",
    "account_print_metrics",
    "account_token_clear",
    "account_token_status",
    "ace_feed_finish",
    "ace_refresh_slot",
    "audit_gcode_recovery",
    "auth_id_flow_start",
    "auth_setup",
    "cad_close_workspace",
    "cad_edit_mesh",
    "cad_generate_from_prompt",
    "cad_generate_parametric",
    "cad_image_to_3d",
    "cad_open_workspace",
    "cad_select_faces",
    "cad_texture",
    "cad_v2_boolean",
    "camera_cloud_info",
    "camera_watch",
    "cancel_print",
    "discover_printers",
    "firmware_update_check",
    "get_slice_job",
    "inspect_slicer",
    "list_slicer_profiles",
    "nfc_tag_decode",
    "nfc_tag_plan",
    "open_model_in_slicer",
    "open_slicer",
    "prepare_slice_job",
    "printer_capability_catalog",
    "printer_command_catalog",
    "printer_command_send",
    "printer_connection_close",
    "printer_connection_status",
    "printer_diagnostics",
    "printer_edge_stop",
    "printer_error_list",
    "printer_event_watch",
    "printer_file_preview",
    "printer_gcode_resolve",
    "printer_hidden_command_map",
    "printer_http_readonly_diagnostics",
    "printer_lan_camera",
    "printer_lan_command_preview",
    "printer_lan_handshake",
    "printer_lan_read",
    "printer_lifetime_metrics",
    "printer_material_catalog",
    "printer_metrics_expose",
    "printer_monitor",
    "printer_order_registry",
    "printer_print_start",
    "printer_property_catalog",
    "printer_property_reconcile",
    "printer_read_all",
    "printer_rename",
    "printer_status",
    "printer_status_snapshot",
    "run_slice_job",
    "send_to_printer",
    "slice_via_app",
    "slicer_component_inventory",
    "slicer_export_3mf",
    "slicer_profiles",
    "slicer_settings",
    "slicer_slice",
    "spool_bind",
    "spool_consume_from_slice",
    "spool_register",
    "spool_resolve",
    "spool_status",
    "spool_usage",
    "start_print",
    "uia_click",
    "uia_key",
    "uia_read",
    "uia_tree",
    "uia_type",
  ]);
  const inspected = await client.callTool({ name: "inspect_slicer", arguments: {} });
  assert.equal(inspected.isError, undefined);
  // Cloud login: either fails cleanly with the expected message when no token is
  // available, or succeeds when a token is already stored (DPAPI). Never crash.
  const login = await client.callTool({ name: "account_login", arguments: {} });
  const loginTxt = JSON.stringify(login);
  if (login.isError) {
    assert.match(loginTxt, /access_token/);
  } else {
    assert.match(loginTxt, /"ok":true/);
  }
  // Token status must always respond, regardless of stored state.
  const status = await client.callTool({ name: "account_token_status", arguments: {} });
  assert.equal(status.isError, undefined);
  assert.match(JSON.stringify(status), /"ok":true/);
  assert.match(JSON.stringify(status), /"stored":(true|false)/);
  // CAD workspace: must start on localhost (no browser), report a URL+token, then close cleanly.
  const cad = await client.callTool({
    name: "cad_open_workspace",
    arguments: { open_browser: false },
  });
  assert.equal(cad.isError, undefined);
  const cadTxt = JSON.stringify(cad);
  assert.match(cadTxt, /"ok":true/);
  assert.match(cadTxt, /http:\/\/127\.0\.0\.1:(\d+)/);
  // CAD agent tools against the live workspace: create a box, select its top
  // planar region (2 tris), extrude it and apply a color — verifying the
  // agent tools share the same workspace state as the UI.
  const baseUrl = cadTxt.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[0];
  assert.ok(baseUrl, "cad url missing");
  const tokenMatch = cadTxt.match(/[a-f0-9]{32}/);
  const cadToken = tokenMatch ? tokenMatch[0] : "";
  const cadFetch = async (action, body) => {
    const r = await fetch(`${baseUrl}/api/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Cad-Token": cadToken },
      body: JSON.stringify(body),
    });
    return r.json();
  };
  await cadFetch("add", {
    name: "smoke_box",
    params: { kind: "box", width: 20, height: 10, depth: 20 },
  });
  const cadSel = await client.callTool({
    name: "cad_select_faces",
    arguments: { object: "smoke_box", grow_from_face: 0 },
  });
  assert.equal(cadSel.isError, undefined, JSON.stringify(cadSel));
  assert.match(JSON.stringify(cadSel), /"ok":true/);
  const cadEdit = await client.callTool({
    name: "cad_edit_mesh",
    arguments: { object: "smoke_box", op: "extrude", amount: 2 },
  });
  assert.equal(cadEdit.isError, undefined, JSON.stringify(cadEdit));
  assert.match(JSON.stringify(cadEdit), /"ok":true/);
  const cadTex = await client.callTool({
    name: "cad_texture",
    arguments: { object: "smoke_box", color: [200, 100, 50] },
  });
  assert.equal(cadTex.isError, undefined, JSON.stringify(cadTex));
  // Robust boolean (three-bvh-csg): add a cylinder, then subtract it through the
  // box via cad_v2_boolean — the result must exist and be watertight (hole).
  await cadFetch("add", {
    name: "smoke_cyl",
    params: { kind: "cylinder", radius: 4, height: 30, segments: 32 },
  });
  const cadBool = await client.callTool({
    name: "cad_v2_boolean",
    arguments: {
      url: baseUrl,
      token: cadToken,
      name_a: "smoke_box",
      name_b: "smoke_cyl",
      op: "subtract",
      result_name: "smoke_holed",
    },
  });
  assert.equal(cadBool.isError, undefined, JSON.stringify(cadBool));
  const cadBoolTxt = JSON.stringify(cadBool);
  assert.match(cadBoolTxt, /"ok":true/);
  assert.match(cadBoolTxt, /"watertight":true/);
  // Parametric engine (manifold): run a declarative script and expect a mesh.
  const cadParam = await client.callTool({
    name: "cad_generate_parametric",
    arguments: {
      url: baseUrl,
      token: cadToken,
      script: "let b = box(20, 20, 10); let h = cylinder(4, 30, 48); return subtract(b, h);",
      object_name: "smoke_param",
      export_format: "stl",
    },
  });
  assert.equal(cadParam.isError, undefined, JSON.stringify(cadParam));
  const cadParamTxt = JSON.stringify(cadParam);
  assert.match(cadParamTxt, /"ok":true/);
  assert.match(cadParamTxt, /"watertight":true/);
  assert.match(cadParamTxt, /"triangles":\d+/);
  // AI text-to-cad: dry_run must answer with a script, no provider needed.
  const cadAi = await client.callTool({
    name: "cad_generate_from_prompt",
    arguments: { prompt: "30mm cube", dry_run: true },
  });
  assert.equal(cadAi.isError, undefined, JSON.stringify(cadAi));
  const cadAiTxt = JSON.stringify(cadAi);
  assert.match(cadAiTxt, /"dry_run":true/);
  assert.match(cadAiTxt, /"script":/);
  const cadClose = await client.callTool({ name: "cad_close_workspace", arguments: {} });
  assert.equal(cadClose.isError, undefined);
  assert.match(JSON.stringify(cadClose), /"stopped":true/);
  process.stdout.write(
    `MCP smoke test passed: ${names.length} tools; inspect_slicer, account_login (clean fail), account_token_status, cad workspace responded.\n`,
  );
} finally {
  await client.close();
}
