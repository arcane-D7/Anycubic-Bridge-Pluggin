# Anycubic Slicer Next 2.0.0.3 - Ghidra and CLI Analysis

Date: 2026-09-27
Status: read-only analysis completed for the executable and integration DLL set
Scope: native application, slicing integration, Workbench boundary, cloud MQTT transport, request filtering and cryptographic dependencies

## Executive Summary

The installed Anycubic Slicer Next 2.0.0.3 is not a single monolithic executable from an integration perspective. Its relevant behavior is divided across several native modules:

- `AnycubicSlicerNext.exe`: GUI application entry point and application composition layer.
- `AnycubicSlicer.dll`: the large native slicing/model configuration engine.
- `Workbench.dll`: a small native boundary exposing package information and handler registration.
- `cloud_mqtt.dll`: Anycubic cloud topic construction, authentication-related preparation, event/action mapping and message publication.
- `mqtt_client.dll`: asynchronous MQTT client implementation and connection lifecycle.
- `MachMQTT.dll`: a thin native adapter that creates and manages MQTT clients for the application.
- `common_encrypt.dll`: cryptographic and certificate-related support.
- `RequestFilter.dll`: request construction boundary exposed through `make_js(Account*)`.

The central conclusion is that the bridge should not treat Windows UI Automation or direct edits to `_temp_*.config` as the authoritative control plane. The native application has at least five state layers:

1. System and user preset JSON files.
2. The `.3MF` project package and embedded Metadata configuration.
3. A temporary live session file such as `_temp_1.config`.
4. The in-memory Workbench/UI model.
5. The exported, firmware-compatible G-code 3MF.

The static analysis confirms the existence of the native Workbench and MQTT boundaries, but it does not yet prove the ABI or event contract of `Workbench.registerHandler`. That ABI must remain unexposed until focused call-site analysis or controlled runtime observation establishes it.

## Analysis Provenance

### Tools

- Ghidra `12.1.4_PUBLIC` headless analyzer.
- Radare2 `6.1.6` x64.
- PowerShell and local PE metadata inspection.
- Existing MCP source and tests in this repository.
- Existing local analysis artifacts under `local-scripts/ghidra-analysis/`.

No binary was modified. No patch was applied to the slicer. No native command was sent to the printer as part of this analysis.

### Reproducibility

The following values are placeholders by design and must be replaced locally when reproducing the analysis:

- `<SLICER_INSTALL_ROOT>`: the Anycubic Slicer Next installation directory.
- `<REPO_ROOT>`: the local repository root.
- `<GHIDRA_HOME>`: the Ghidra installation directory.
- `<R2_BIN>`: the Radare2 executable directory.

Example executable analysis:

```powershell
$gh = "<GHIDRA_HOME>"
$exe = "<SLICER_INSTALL_ROOT>\\AnycubicSlicerNext.exe"
$project = "<REPO_ROOT>\\local-scripts\\ghidra-analysis\\project"
New-Item -ItemType Directory -Force $project | Out-Null
& "$gh\\support\\analyzeHeadless.bat" `
  $project `
  AnycubicSlicerNext-analysis `
  -import $exe `
  -analysisTimeoutPerFile 180 `
  -overwrite
```

Example Radare2 PE triage:

```powershell
$r2 = "<R2_BIN>\\radare2.exe"
& $r2 -q -e bin.relocs.apply=true `
  -c "iI; iE; ii; iS; q" `
  "<SLICER_INSTALL_ROOT>\\cloud_mqtt.dll"
```

All long-running analysis commands must use a bounded timeout or an external process timeout. Do not use an MCP call as the only watchdog for a full-binary analysis.

## Target Inventory

The following target set was analyzed:

| Module                   | Role                                    | Relevant evidence                                                                       |
| ------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------- |
| `AnycubicSlicerNext.exe` | GUI application entry point             | PE32+, x86-64, MSVC, image base `0x140000000`, product version `2.0.0.3`                |
| `AnycubicSlicer.dll`     | Native slicing and configuration engine | Slic3r configuration classes, dynamic config types and serialization metadata           |
| `Workbench.dll`          | Application/workbench boundary          | Exports `getPackageInfo` and `registerHandler`                                          |
| `cloud_mqtt.dll`         | Anycubic cloud MQTT abstraction         | Topic creation, message push, password calculation, PEM retrieval, action/event mapping |
| `mqtt_client.dll`        | MQTT implementation                     | Connect, publish, subscribe, disconnect, sinks and Paho-derived implementation          |
| `MachMQTT.dll`           | Application MQTT adapter                | Client initialization, creation and deinitialization exports                            |
| `common_encrypt.dll`     | Crypto and certificate support          | BCrypt/Crypt32/OpenSSL-related imports and error strings                                |
| `RequestFilter.dll`      | Request/signature construction boundary | Export `make_js(Account*)` and crypto/network imports                                   |

### Version and hash evidence

The installed main application reports:

- Product: `AnycubicSlicerNext`
- Version: `2.0.0.3`
- Company: Anycubic

The local analysis metadata contains hashes for the native targets. The complete machine-specific hash record is kept in the ignored artifact `local-scripts/ghidra-analysis/metadata/hashes.json` and is not duplicated here as a runtime contract.

## Ghidra Analysis Results

### Main executable

Ghidra identified the executable as:

- Format: PE32+
- Architecture: x86-64 / AMD64
- Endianness: little endian
- Compiler family: MSVC
- Operating system: Windows
- Image base: `0x140000000`
- Subsystem: Windows GUI
- TLS callbacks present
- ASLR/relocation metadata present in the PE
- PDB path referenced by the binary, but the matching PDB was not available locally

Auto-analysis completed successfully. The missing PDB is important: it prevents source-level private names and exact original function names for the main executable. It does not prevent PE structure, imports, exports, strings, function discovery or decompiler-guided analysis.

### Native configuration types in AnycubicSlicer.dll

The native slicing module contains RTTI and type metadata associated with the Orca/Slic3r-derived configuration system, including names corresponding to:

- `Slic3r::ConfigBase`
- `Slic3r::DynamicConfig`
- `Slic3r::DynamicPrintConfig`
- `Slic3r::ModelConfig`
- `Slic3r::ModelConfigObject`
- `Slic3r::ConfigOption*` variants
- Cereal polymorphic serialization registrations

This is consistent with the observed behavior of the slicer: settings are represented as native configuration objects and serialized to project/session/preset files. The presence of these types does not, by itself, identify the function that applies a JSON configuration object to the active GUI model.

### Workbench.dll exports

Radare2 and the Ghidra import confirmed these exports:

| Symbol            | Virtual address | File offset |
| ----------------- | --------------: | ----------: |
| `getPackageInfo`  |   `0x180001000` |     `0x400` |
| `registerHandler` |   `0x180001010` |     `0x410` |

`Workbench.dll` is small compared with the slicing engine. Its size and export shape make it a strong candidate for an adapter boundary rather than the complete implementation of project state. The names suggest:

- `getPackageInfo`: retrieval of package/application/workbench metadata.
- `registerHandler`: registration of callbacks or message handlers.

The exact ABI is unresolved. The export names are not sufficient evidence to call either function from the bridge.

### Cloud MQTT exports

`cloud_mqtt.dll` exports the following relevant functions:

```text
Anycubic::CloudMqtt::Setup
Anycubic::CloudMqtt::Shutdown
Anycubic::CloudMqtt::CreateInstance
Anycubic::CloudMqtt::CreateTopic
Anycubic::CloudMqtt::PushMessage
Anycubic::CloudMqtt::CalculatePassword
Anycubic::CloudMqtt::GetPems
Anycubic::CloudMqtt::EnumToAction
Anycubic::CloudMqtt::EnumToEvent
```

The demangled signatures provide useful shape information:

```text
CreateInstance(PrinterType, CloudMqttHandler*) -> HandlerRouter*
CreateTopic(char**, const char*, const char*, const char*, int) -> bool
PushMessage(HandlerRouter*, const char*, const char*, unsigned int) -> bool
CalculatePassword(CalculateConfig&) -> bool
GetPems(Pem const&) -> bool
EnumToAction(CloudActionType) -> const char*
EnumToEvent(CloudEventType) -> const char*
```

These signatures establish that the native cloud layer has an explicit topic builder and message publisher. They do not reveal the full wire envelope or validate any control operation. Existing project evidence remains the authority for exposed cloud commands.

### MQTT topics

The binary contains these topic templates:

```text
anycubic/anycubicCloud/v1/+/public/{}/{}/#
anycubic/anycubicCloud/v1/slicer/printer/{}/{}/{}
```

The first template indicates a public/report-style wildcard subscription or routing family. The second explicitly identifies a slicer-to-printer path with model/device/type placeholders. The exact placeholder ordering and runtime substitutions must be confirmed by call-site analysis or captured runtime traffic.

### mqtt_client.dll

The module contains an asynchronous MQTT client implementation with symbols and strings for:

```text
mqtt_init_client
mqtt_create_client
mqtt_connect_to_broker
mqtt_publish
mqtt_subscribe
mqtt_unsubscribe
mqtt_disconnect
mqtt_destroy_client
mqtt_is_connected
mqtt_add_sink
```

The module contains Eclipse Paho MQTT C implementation markers and source path strings for asynchronous MQTT, socket, TLS socket, persistence and packet components. Imports include networking and cryptographic Windows APIs.

The bridge implication is clear: MQTT connection lifecycle and publication are native abstractions, but the existing MCP should continue using its own validated client boundary instead of attempting to call these exports directly.

### MachMQTT.dll

`MachMQTT.dll` is a small adapter over `mqtt_client.dll`. Confirmed exports:

```text
MachMqtt_Init
MachMqtt_CreateClient
MachMqtt_Deinit
Creator
Destory
```

The misspelled `Destory` spelling is preserved exactly as exported by the binary. It should not be “corrected” when using symbol-based analysis.

The presence of `MachMqtt_CreateClient` and the import relationship to `mqtt_client.dll` confirms the layering:

```text
Anycubic Slicer / cloud layer
        -> MachMQTT adapter
        -> mqtt_client implementation
        -> Winsock / TLS / Paho
```

### RequestFilter.dll

`RequestFilter.dll` exports:

```text
make_js(Account*) -> const char*
```

The DLL imports cryptographic, certificate, network and Windows security APIs. Its name and export shape suggest request construction or request filtering, but no exact signing scheme was inferred from the export alone.

The bridge must not:

- call `make_js` with guessed structures;
- extract or reuse private keys from the binary;
- bypass the existing token redaction and credential handling;
- treat a static string or export as proof of a valid request contract.

### common_encrypt.dll

`common_encrypt.dll` contains OpenSSL/BCrypt/Crypt32-related symbols, certificate chain strings and crypto error messages. It appears to support TLS/certificate and encryption operations used by the cloud stack. Static presence of crypto APIs does not prove a specific algorithm or key derivation scheme.

## Relationship to the MCP implementation

The current MCP architecture already exposes safer, higher-level boundaries:

- Native CLI invocation through `slicer-cli.mjs`.
- Profile resolution through `slicer_profiles` and `resolvePresets`.
- Resolved settings through `slicer_settings`.
- Live session inspection through `slicer_live_sessions` and `slicer_live_settings`.
- Verified session mutation through `slicer_apply_project_settings`.
- Explicit refresh through `slicer_refresh_project`.
- Snapshot and rollback through `slicer_live_snapshot` and `slicer_live_rollback`.
- Preflight and workflow planning through `slicer_preflight` and `slicer_agentic_plan`.
- Agentic slicing through `slicer_agentic_slice`.
- Redacted auditing through `slicer_operation_history`.
- Capability disclosure through `slicer_capability_catalog`.

These tools intentionally do not call the native Workbench exports. They operate through documented filesystem, CLI and UIA boundaries with explicit read/write annotations and confirmation gates.

## State consistency model

The observed configuration mismatch is explained by the following state consistency problem:

```text
Preset JSON ------------------------+
                                     |
Project .3MF Metadata --------------+--> native configuration object
                                     |             |
_temp_*.config ----------------------+             +--> UI controls
                                                   |
                                                   +--> CLI export
                                                   |
                                                   +--> saved project / G-code 3MF
```

A direct write to `_temp_*.config` changes a file, but does not prove that the in-memory native configuration object or UI controls changed. Conversely, a UI edit may change memory first and serialize later. The current MCP therefore reports these stages independently:

- file write;
- refresh dispatched;
- optional save dispatched;
- settings readback;
- slice result;
- artifact compatibility.

This distinction is required for reliable AgenticUse behavior.

## Confirmed versus unresolved contract

### Confirmed

- The executable and integration DLLs are PE32+ x86-64 Windows binaries.
- The slicer has a native Workbench boundary.
- The slicer has a native cloud MQTT boundary.
- MQTT uses explicit connection, publication and subscription layers.
- The slicing engine uses native dynamic configuration objects.
- The native cloud layer constructs topics and publishes messages.
- The MCP can safely invoke the native CLI and validate generated artifacts.
- The MCP can inspect and transact over live `_temp_*.config` sessions.

### Unresolved

- ABI of `Workbench.registerHandler`.
- Return structure of `Workbench.getPackageInfo`.
- Handler names and callback table layout.
- Native project reload/apply event.
- Native save transaction and dirty-state mechanism.
- Direct relation between CLI settings and Workbench in-memory state.
- Exact native mapping from internal actions to cloud MQTT envelopes.
- Whether geometry-only and GUI-saved 3MF projects take different initialization paths.

## Security and safety boundaries

The analysis is read-only. The following remain deliberately blocked:

- Patching the slicer binaries.
- Calling undocumented Workbench exports.
- Calling `RequestFilter.make_js` with guessed data.
- Extracting private credentials or keys.
- Sending unvalidated MQTT control messages.
- Starting, pausing, stopping or modifying a print as part of static analysis.

Existing printer tools retain their confirmation and `EXECUTE` gates. Static evidence is treated as documentation, not as authorization to expose new actions.

## Recommended next investigations

1. Run bounded Radare2 disassembly for `getPackageInfo` and `registerHandler`.
2. Inspect import tables and xrefs in the executable and `AnycubicSlicer.dll`.
3. Search Ghidra strings and references for `registerHandler`, `getPackageInfo`, `_temp_`, `process_settings`, `project_settings`, and `save`.
4. Compare live UI operations with filesystem timestamps and process memory snapshots.
5. Capture only read-only native MQTT traffic during project load and status refresh.
6. Add a controlled project transaction test:
   - snapshot live config;
   - apply one harmless setting;
   - refresh;
   - read back;
   - save a copy;
   - compare `.3MF` hashes and metadata;
   - rollback.

## Evidence locations

All raw and generated evidence is kept in the ignored local directory:

```text
local-scripts/ghidra-analysis/
```

Important files include:

- `REPORT.md`: initial analysis summary.
- `metadata/modules.json`: installed module metadata.
- `metadata/hashes.json`: local target hashes.
- `r2-triage/*.txt`: Radare2 PE, sections, imports and exports.
- `strings-ps/*.txt`: local ASCII/UTF-16 string extraction.
- `project/`: Ghidra project databases.

The local artifact directory is intentionally not part of the repository history.
