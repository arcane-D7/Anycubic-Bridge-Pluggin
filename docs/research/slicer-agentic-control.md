# Anycubic Slicer Next Agentic Control

Date: 2026-09-27

## Implemented in the MCP

The slicer control surface now distinguishes the live application session from the CLI and from the project 3MF.

- `slicer_live_sessions` — read-only listing of running slicer processes, temporary project sessions, origin 3MF and active `_temp_*.config` files.
- `slicer_live_settings` — read-only dump of the effective settings persisted in the active session.
- `slicer_apply_project_settings` — gated write that updates the active session config, verifies the written keys, optionally refreshes the UI, and does not save with `Ctrl+S` by default.
- `slicer_refresh_project` — gated `F5` refresh of the selected slicer window without saving, slicing, exporting or modifying geometry.
- `slicer_agentic_slice` — gated workflow that synchronizes optional live settings, refreshes and reads them back, invokes the native CLI, and validates the produced 3MF before any printer operation.

The live settings writer accepts `_temp_1.config`, `_temp_2.config`, `_temp_3.config` and other numbered session files. It no longer assumes `_temp_3.config`.

## Important state model

The installed slicer has several state layers:

1. System/user preset JSON files.
2. The project package (`.3MF`) and its Metadata configuration.
3. The temporary live session config (`_temp_*.config`).
4. The in-memory Workbench/UI state.
5. The exported firmware-compatible 3MF.

Writing layer 3 alone is not proof that layer 4 changed. The MCP therefore reports the file path, before/after/verified values, refresh status and optional save status separately.

`Ctrl+S` is not the default application path because the GUI can reserialize stale in-memory state over the edited temporary config. Use `slicer_refresh_project` for a non-saving refresh and only opt into saving after a live verification.

## Static analysis findings

Ghidra headless and Radare2 analysis of Anycubic Slicer Next 2.0.0.3 and the integration DLLs found:

- `cloud_mqtt.dll`: `Setup`, `Shutdown`, `CreateInstance`, `CreateTopic`, `PushMessage`, `CalculatePassword`, `GetPems`, `EnumToAction`, `EnumToEvent`.
- `MachMQTT.dll`: `MachMqtt_Init`, `MachMqtt_CreateClient`, `MachMqtt_Deinit`.
- `mqtt_client.dll`: native MQTT connect, publish, subscribe, disconnect and connection-state functions based on Eclipse Paho.
- `Workbench.dll`: `getPackageInfo`, `registerHandler`.
- `RequestFilter.dll`: `make_js(Account*)`.
- Native topics include `anycubic/anycubicCloud/v1/+/public/{}/{}/#` and `anycubic/anycubicCloud/v1/slicer/printer/{}/{}/{}`.

The static findings support a future native bridge around Workbench handlers and MQTT observation, but do not by themselves establish a safe command ABI. No native binary was modified.

## Next layers

1. Decompile `Workbench.registerHandler` and `getPackageInfo` with bounded headless jobs.
2. Resolve xrefs from `CreateTopic` and `PushMessage` to the native printer command envelopes.
3. Add a read-only application capability catalog backed by verified binary/runtime evidence.
4. Add explicit project reload/save transactions with before/after 3MF fingerprints.
5. Add agentic workflows that compose profile selection -> live apply -> refresh -> readback -> slice -> compatibility validation.
6. Keep all printer motion, thermal, job, upload and firmware operations behind existing confirmation gates.
