# License Policy Registry

> **Policy (user-confirmed 2026-09-28, binding):** direct use/implementation of a
> dependency = **Apache-2.0 or MIT only**. Every other license (GPL, AGPL, BSD-3,
> LGPL, MPL, ...) is **reference-of-information / comparison / study-only** — its
> code is never copied, imported, linked, adapted or bundled into this repository.
> External-process **prerequisites** (pinned Blender GPL, Anycubic Slicer Next CLI)
> are **user-installed/discovered**, never bundled; versions and legal notices
> travel with the docs.
>
> Enforcement: `scripts/check-licenses.mjs` fails on any direct dep whose SPDX id
> is not Apache-2.0/MIT (unless allowlisted dev-only tooling). This page is the
> human-readable half of that registry.

## How a project may be used

| Classification            | Meaning                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| **Direct (Apache/MIT)**   | Code may be imported, linked, bundled or implemented from.            |
| **Reference-only**        | Studied for algorithms/behavior; code NOT copied. Citations required. |
| **External prerequisite** | User-installed executable/process required at runtime; never bundled. |

## Registry

| Project                           | License                        | Allowed use                                           | Rationale / citation                                                                 |
| --------------------------------- | ------------------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| manifold-3d                       | Apache-2.0                     | Direct                                                | CAD boolean/parametric kernel (Sprint 2)                                             |
| three-bvh-csg                     | MIT                            | Direct                                                | Precipice CSG for browser UI (Sprint 1)                                              |
| three                             | MIT                            | Direct                                                | R3F/3D viewport renderer                                                             |
| three-mesh-bvh                    | MIT                            | Direct                                                | BVH acceleration for three.js                                                        |
| replicad / replicad-opencascadejs | Apache-2.0 (family)            | Direct — conversion-only tier                         | STEP/OCCT conversion; kernel math stays in our engine                                |
| wasmtime                          | Apache-2.0                     | Direct                                                | WASI capability sandbox (Sprint 9 harness)                                           |
| Kiri:Moto                         | Client MIT; engine unconfirmed | Reference-only                                        | Client code studied for patterns; engine license unconfirmed, not used               |
| CurviSlicer                       | AGPL-3.0                       | Study-only                                            | Paper + code studied for conformal slicing; AGPL code never imported (Sprint 12)     |
| Zip-o-mat                         | GPL                            | Study-only                                            | Paper/reference for slicing patterns                                                 |
| RotBot                            | GPL                            | Study-only                                            | Paper/reference                                                                      |
| NeuralSlicer                      | AGPL                           | Study-only                                            | Paper/reference                                                                      |
| FullControl                       | GPL                            | Study-only                                            | Paper/reference (G-code generation)                                                  |
| S4_Slicer                         | GPL/AGPL                       | Study-only                                            | Multi-axis reference                                                                 |
| S3-Slicer                         | BSD-3                          | Study-only[^1]                                        | Slicing strategy reference; BSD-3 code not copied                                    |
| COMPAS                            | MIT                            | Reference                                             | Python framework patterns; not a runtime dep                                         |
| Open5x                            | MIT                            | Reference                                             | 5-axis reference implementation patterns                                             |
| Blender                           | GPL                            | External prerequisite — user-installed, never bundled | Pinned version; geometry/rendering authority over named capabilities only (Sprint 7) |
| Anycubic Slicer Next CLI          | proprietary                    | External prerequisite — user-installed, never bundled | CLI/executable orchestrated via separate process; validation only                    |
| Goose                             | `[?]` — re-check               | Reference/verify                                      | License unverified; must be re-checked before any use                                |

## Legacy runtime dependencies (pre-policy, migration tracked)

These entered the preserved root before the license policy was confirmed. They
are **retained** (removing them would break preserved functionality, which
S5-002 freezes) but are NOT Apache/MIT and must be **migrated or removed** before
any new feature depends on them. `scripts/check-licenses.mjs` allowlists them
with this justification; the migration is tracked in Sprint 10+ (auth service rework).

| Package                      | License                 | Used in                                                    | Migration plan                                                                                                                  |
| ---------------------------- | ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| node-forge@1.4.0             | BSD-3-Clause OR GPL-2.0 | `scripts/anycubic-cloud.mjs` (cloud PKI cert verification) | Replace with WebCrypto-based verification (no bundled cert parser) when the cloud module is refactored                          |
| replicad-opencascadejs@1.1.0 | LGPL-2.1-only           | `scripts/cad-step-export.mjs` (optional STEP export)       | Already graceful-fallback to STL; keep optional, never a hard dep — migrate to Apache-2.0 OCCT wrapper if STEP export must stay |

[^1]: BSD-3 is permissive but not Apache/MIT. Per user policy it is **reference-only** — BSD-3 _code_ is not copied.

## Direct-use dependency allowlist (dev-only tooling)

These are dev-time tools, never shipped in the runtime bundle; they are allowlisted
in `scripts/check-licenses.mjs` with justification comments:

| Package             | License    | Why allowed                 |
| ------------------- | ---------- | --------------------------- |
| esbuild             | MIT        | Build-time bundler          |
| husky               | MIT        | Git hooks                   |
| lint-staged         | MIT        | Pre-commit formatter runner |
| prettier            | MIT        | Formatter                   |
| puppeteer-core      | Apache-2.0 | E2E browser harness         |
| tsx                 | MIT        | Dev TS runner               |
| eslint / @eslint/js | MIT        | Linting                     |
| typescript-eslint   | MIT        | TS lint wiring              |
| knip                | ISC        | Dead-code detection         |

## Rules of thumb

1. A new **runtime** dependency must be Apache-2.0 or MIT — otherwise it is
   reference-only and must never appear in `package.json` dependencies.
2. A dev-only tool that is not Apache/MIT may be added to the allowlist **with a
   justification comment**; the gate will then pass it explicitly.
3. Anything **studied** must get a row here (license + allowed use + citation)
   before its findings are encoded in a design doc.
4. If a license is unknown (`?`), the entry is **reference/verify** until resolved.
