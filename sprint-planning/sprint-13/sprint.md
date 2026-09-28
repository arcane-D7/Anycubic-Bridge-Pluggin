# Sprint 13 — R7: Sandbox Hardening (T3b VM) + S4 Multi-Axis Research

## Sprint Metadata

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Sprint Name**       | R7 — T3b VM sandbox hardening (Linux dev-VM first; Windows off-by-default) + S4 continuous multi-axis research on real catalog profiles only                                                                                                                                                                                                                             |
| **Sprint Goal**       | Harden the sandbox to the native-VM tier (T3b) for genuinely untrusted native/model-generated code — Linux dev-VM first, Windows Hyper-V isolated or Windows Sandbox evaluated then deferred, off-by-default — and run the S4 research spike for continuous multi-axis printing against machines that actually exist in the capability catalog (no "any printer" claim). |
| **Duration Estimate** | ~5 weeks                                                                                                                                                                                                                                                                                                                                                                 |
| **Priority**          | P2 (research + hardening)                                                                                                                                                                                                                                                                                                                                                |
| **Sprint Type**       | Feature/Research                                                                                                                                                                                                                                                                                                                                                         |
| **Primary Owner**     | harness-core / engine-nonplanar                                                                                                                                                                                                                                                                                                                                          |
| **Source**            | [custom-slicer-editor-investigation-2026-09-27.md](../../docs/research/custom-slicer-editor-investigation-2026-09-27.md) Rev 2.0 §8 (harness tiers), §5.1 (joints/rotary model), §3 (S4 multi-axis), §10 R7                                                                                                                                                              |
| **Depends On**        | Sprint 12 (R6)                                                                                                                                                                                                                                                                                                                                                           |
| **Status**            | ⏳ Planned                                                                                                                                                                                                                                                                                                                                                               |

## ⚠️ MANDATORY COMPLETION REQUIREMENT

> **MANDATORY: 100% of the tickets in this sprint MUST be completed. The sprint will
> NOT be accepted as delivered if any ticket remains incomplete.**
>
> Every ticket must pass its acceptance criteria AND the full health check suite
> before the sprint commit is made.

## Sprint Goal Statement

T3b is the only tier that isolates **native** (non-Wasm) model-generated code — a process
inside a throwaway VM. Linux dev-VM path first (fastest, cheapest, reproducible); Windows
Hyper-V isolation and Windows Sandbox are evaluated in a spike doc and deferred (off-by-default
on Windows for now, per §8.2). Native tool attempts must never silently fall back to T1/T3a.
S4 (continuous multi-axis) is a research spike that emits **no production claims**: it drives
the §5.1 joint/kinematic model against a machine profile that actually exists in the catalog
(real joint/rotary configuration declared), studies LinuxCNC 5-axis conventions, and keeps
S3-Slicer (BSD-3), Open5x (MIT) and S4_Slicer (GPL-3.0) + FullControl (GPL-3.0) as study-only
references per §🔒. Acceptance is defined at spike time against the real catalog profile; no
claims for absent profiles.

## Health Check Commands (must pass before commit)

```bash
pnpm run check
pnpm run sandbox-r7      # T3b: VM bring-up, native tool attempt → T3b-only (never T1 fallback), kill/reap, no T3b auto-enable on Windows
node scripts/sanitize-repo.mjs --dry-run
```

## Tickets

### S13-001 — T3b VM design spike + Windows decision (off-by-default)

| Field                | Value                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S13-001                                                                                               |
| **Title**            | T3b VM architecture spike (Linux dev-VM vs Windows Hyper-V/Sandbox) + Windows off-by-default decision |
| **Priority**         | P1                                                                                                    |
| **Type**             | Research/Spike                                                                                        |
| **Estimated Effort** | M                                                                                                     |
| **Source Finding**   | Invest. Rev 2.0 §8.2 (T3b native VM, off-by-default on Windows)                                       |
| **Status**           | ⏳ Planned                                                                                            |

#### Context

T3b = the only tier that isolates native code. Windows Hyper-V isolated containers and Windows
Sandbox are heavyweight; the spike evaluates both + a Linux dev-VM (CI-grade, reproducible)
before deciding the first path. Whatever the outcome, on Windows T3b is off by default and
requires explicit opt-in (§8.2).

#### Acceptance Criteria

- [ ] Spike doc `docs/research/t3b-vm-spike.md`: comparison matrix (boot cost, isolation guarantees, snapshot/discard, attacker-escape surface, dev velocity) for Linux dev-VM vs Hyper-V isolated vs Windows Sandbox; recommendation + roadmap to bring the chosen path online.
- [ ] Decision recorded: Linux dev-VM first (expectation); Windows paths remain off-by-default behind the `t3b.enabled` flag; JDK/etc. prerequisites documented.
- [ ] T3b config flag exists in the broker config with documented security semantics; never auto-enabled (test: on Windows the flag defaults false and a test asserts an attempt without the flag yields `T3b not available`, never a silent T1/T3a fallback — tying to S9-002).
- [ ] Health gate green.

### S13-002 — T3b worker: throwaway VM session (Linux dev-VM first), capability-gated

| Field                | Value                                                                   |
| -------------------- | ----------------------------------------------------------------------- |
| **Ticket ID**        | S13-002                                                                 |
| **Title**            | Native code execution in throwaway VM with capability gates + watchdog  |
| **Priority**         | P1                                                                      |
| **Type**             | Feature                                                                 |
| **Estimated Effort** | XL                                                                      |
| **Source Finding**   | Invest. Rev 2.0 §8.2 (T3b: untrusted native code, VM, capability-gated) |
| **Status**           | ⏳ Planned                                                              |

#### Context

Model-generated native artifacts (or hand-approved binaries) run inside the throwaway VM —
never on the host. Capability/deny script, network egress deny, mounts read-only (except
scratch), disposable session (boot → run → snapshot-discard → confetti), watchdog + kill/reap.
The VM session is proven dead after every run (no orphan processes on host).

#### Acceptance Criteria

- [ ] Linux dev-VM T3b integration: boot, transfer artifact, run with capability env (deny script: no net, no host mounts beyond scratch, no secrets in env — asserted by test), return output to scratch, snapshot-discard, verify host has zero leftover processes (kill/reap test).
- [ ] Only T3b routes native tool execution; a tool that needs native code is _routed_ to T3b only, never downgraded to T1/T3a; a tool that needs Blender = the broker-proxied named capability as always (S9-004), because Blender remains T2 first-party.
- [ ] Watchdog mandatory (S9-002 same rule); fuel and wall-clock both enforced; VM disk wiped (scratch always discarded, never reused across sessions).
- [ ] Windows behavior: T3b off by default; if on (explicit opt-in), Hyper-V isolated session per S13-001 decision; otherwise the attempt fails cleanly (see S13-001 test).
- [ ] E2E: submit a "native tool" fixture to the harness → T3b-only handling; host resource isolation verified.
- [ ] Health gate green.

### S13-003 — S4 spike: continuous multi-axis feasibility against existing catalog profiles

| Field                | Value                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S13-003                                                                                                                      |
| **Title**            | S4 continuous multi-axis feasibility spike on actually-existing catalog profiles                                             |
| **Priority**         | P2                                                                                                                           |
| **Type**             | Research/Spike                                                                                                               |
| **Estimated Effort** | L                                                                                                                            |
| **Source Finding**   | Invest. Rev 2.0 §3 (S4 multi-axis, no "any printer" claim), §5.1 (joints/kinematic model), §8 (no claim for absent profiles) |
| **Status**           | ⏳ Planned                                                                                                                   |

#### Context

S4 is continuous multi-axis printing. Feasibility is asserted **only** against a machine that
exists in the capability catalog with a declared joint/rotary configuration (e.g. a 6-axis arm
or a rotary-tilt FDM cell if it is in the catalog; otherwise "no in-catalog machine → S4 stays
research-only"). References: LinuxCNC 5-axis conventions (GPL, study), S3-Slicer (BSD-3 →
study-only per §🔒), Open5x (MIT → study), S4_Slicer (GPL-3.0 → study), FullControl (GPL-3.0 →
inspiration only). No over-claim: if no machine qualifies, the deliverable is a research note

- catalog extension request, not an engine.

#### Acceptance Criteria

- [ ] Catalog scan: list profiles with an actual joint model (≥5 axes or continuous rotary) by the §5.1 `joints` + `tool_envelope` schema; each entry with `source_class` + provenance. Empty → document "no in-catalog S4-capable machine; research-only status" (no claim).
- [ ] If at least one qualifying profile exists: S4 feasibility design `docs/research/s4-multiaxis-spike.md` with FK/Jacobian from the catalog's declared joint config, collision envelope incorporation, and a target print-cell validation plan (hardware gate manual; no production claims).
- [ ] Kinematic convention note: LinuxCNC 5-axis conventions as reference (study), and the IR is extended (if needed) with joint-target segments — never a fake rotary-from-Cartesian shortcut.
- [ ] License registry updated: S3-Slicer/Open5x/S4_Slicer/FullControl rows (study/inspiration; never imported) — `docs/licenses.md` + `scripts/check-licenses.mjs` still green.
- [ ] Unknowns (§11) updated with S4 unknowns (in-feed collision, substrate handling, slicing-at-angle).
- [ ] Health gate green.

### S13-004 — R7 integration: journal/safety-box interaction + full-tier matrix test

| Field                | Value                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- |
| **Ticket ID**        | S13-004                                                                                     |
| **Title**            | Full harness-tier matrix integration test + journal/safety audit for T3b                    |
| **Priority**         | P1                                                                                          |
| **Type**             | Test/Evidence                                                                               |
| **Estimated Effort** | M                                                                                           |
| **Source Finding**   | Invest. Rev 2.0 §8 (tiers T0–T3b), §3.5 (learning journal; VM runs journaled like any tool) |
| **Status**           | ⏳ Planned                                                                                  |

#### Context

End-to-end proof that every tier behaves per the contract: T0 read-only, T1/T3a Wasmtime
deny-by-default + watchdog, T2 pinned trusted workers (Broker-proxied named capability),
T3b VM (off-by-default). Every T3b run is journaled in the learning journal like any tool
(hashes of artifacts in/out, timeout/exit, approval record) — never outside the journal.

#### Acceptance Criteria

- [ ] Tier matrix e2e test: a synthetic workload is routed to the correct tier (read-only ops → T0; wasm → T1/T3a; native → T3b-only w/ flag; Blender ops → T2 proxy) and a wrong-tier request fails (unit + integration).
- [ ] T3b run record: journal entry with artifact in/out hashes, wall-clock, exit/reason, approval id, VM serial (test asserts record completeness).
- [ ] Safety box unchanged by T3b: a VM-native run may not mutate the safety box (structural path test re-runs on T3b data).
- [ ] Rollback/revocation e2e: revoke a T3b-registered tool while running → running instance killed next tick, journaled.
- [ ] Health gate green.

## Sprint Commit

```bash
git add -A
git commit -m "feat(sprint-13): R7 — T3b VM sandbox hardening + S4 multi-axis research"

- S13-001: T3b VM architecture spike + Windows off-by-default decision
- S13-002: throwaway-VM T3b worker (Linux dev-VM first, capability-gated, watchdog)
- S13-003: S4 continuous multi-axis feasibility on real catalog profiles only
- S13-004: full-tier matrix integration test + T3b journal/safety-box audit
```
