# Editor UI/UX Review

**Version 1.0.2** · 2026-10-09 · Impeccable product review

## AI READING INSTRUCTION

Read `[SPEC]` and `[BUG]` blocks for verified implementation facts. Read `[NOTE]` for review context. `[?]` blocks identify limits and unverified capabilities. Do not interpret browser fixtures or UI affordances as proof of native or physical execution.

## 1. Scope and Evidence

**[SPEC]**

- Reviewed Home, Prepare, Preview, and Workbench, including empty Preview, imported toolpaths, navigation, recovery, delayed slice completion, floating chat, notifications, settings, and printer-control affordances.
- Used [PRODUCT.md](../../PRODUCT.md), [DESIGN.md](../../DESIGN.md), and Impeccable's product, audit, and polish guidance.
- Checked live DOM geometry and pointer hit targets at 390, 760, 1024, and 1423 CSS pixels. Responsive E2E covers 390 and 760 pixels.
- Checked light/dark contrast using computed colors with alpha compositing. These samples are not a whole-application WCAG certification.
- Checked Three.js camera state, filament materials, and canvas pixels directly. The desktop and narrow canvas were nonblank.
- No physical printer command, heating, motion, camera activation, upload, or print was initiated by this review.

**[?]**
Screenshot-based visual critique could not run: the mandated `umans-flash (customendpoint)` model was unavailable. DOM measurements and real input tests substantiate interaction and layout findings, but do not replace a visual design review. No overall Impeccable health score or WCAG conformance claim is assigned.

## 2. Page Responsibilities

**[SPEC]**

| Page      | Intended Responsibility                                                       | Verified Current Behavior                                                                                                              | Capability Boundary                                                                                                   |
| --------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Home      | Project entry, recovery, and artifact/history navigation                      | Demo entry, authority recovery, reprint preflight, and late-job navigation checks pass                                                 | Native project fixtures exercise the browser contract, not desktop persistence on this run                            |
| Prepare   | Authoring, plate organization, mesh/slicer presentation, and Slice initiation | Authoring tools and shortcuts are scoped here; Slice remains mounted across navigation                                                 | Real geometry/native slicing have separate existing implementations; this review does not qualify output for printing |
| Preview   | Read-only inspection of the artifact and execution sequence                   | No object authoring, mutable plate tabs, save/restore chip, or authoring Timeline; camera, playback, filters, and revision checks pass | Native slice artifacts remain Preview-only; Demo Slice produces estimates rather than a real artifact                 |
| Workbench | Device observation and operational status                                     | Device panel is a page, not a second floating monitor; source and read-only limits are visible                                         | Cloud diagnostics can be real reads when configured; the current editor has no connected writer/camera transport      |

## 3. Corrected Findings

**[BUG] P1: Demo solids rendered their inner surfaces**

- Symptom: The cone displayed its inner wall, the cube lost its top, and the sphere exposed its inside even with opaque materials and no edge overlays.
- Cause: The Demo generators emitted inward winding for 24 cone side faces, two cube top triangles, and all 120 nondegenerate sphere faces. Cone side normals were also incorrect. The boolean-result box used inward indices. Duplicated sphere poles produced 24 degenerate triangles and unreliable exact vertical ray intersections.
- Fix: Correct triangle orientation at the source, calculate the cone's slope normals, reverse the cube top and boolean-box indices, and give the sphere exact poles with nondegenerate cap triangles. Keep `FrontSide` culling; do not hide invalid geometry with `DoubleSide` or renderer-side automatic rewinding of imported meshes.
- Evidence: Core tests require outward winding, positive signed volume, consistent unit normals, zero degenerate triangles, and cube volume of 8000 cubic millimetres. The browser E2E inspects actual renderer buffers and requires all six exact axial rays to hit the near exterior hemisphere, with no pole offsets or sphere exceptions.
- Direct browser confirmation: Cone has 48 triangles, cube 12, sphere 120; all 18 exterior ray checks pass with `FrontSide`, opacity 1, and project revision still `rev 0`.
- Scope: These changes fix generated Demo geometry. The intentionally separate sphere repair-status fixture remains unchanged; this is not a certification of arbitrary imported geometry or physical-print readiness.
- Earlier verification gap: Material opacity, texture presence, and unchanged buffer fingerprints alone did not detect inward faces. Those checks are retained but are now supplemented by orientation, lighting-normal, and exterior-hit checks.

**[BUG] P1: Slicer surfaces still covered by mesh overlays**

- Symptom: Filament-colored surfaces remained covered by edge lines and selected bounding-box wireframes in Slicer mode.
- Cause: The global edge flag and selection overlays did not respect the presentation mode, although the base material was already opaque.
- Fix: Slicer and legacy Live presentation suppress mesh edges and wireframe selection bounds. Selection uses a subtle material emissive highlight; Mesh retains its optional edges and bounds. Geometry buffers are unchanged.
- Evidence: Three additional core tests and the browser E2E inspect actual R3F model subgraphs, material opacity/transparency, bump textures, restored Mesh edges, and unchanged geometry fingerprints. Direct browser selection confirmed one opaque mesh, no wireframe, emissive intensity `0.14`, and unchanged `rev 0`.
- Screenshot status: A desktop screenshot was captured after the fix, but screenshot analysis remains blocked by the unavailable mandated vision model. The verified findings above come from code, scene state, and real input rather than screenshot interpretation.

**[BUG] P1: Incorrect page context**

- Symptom: Preview exposed authoring controls, while Home exposed editor-only actions.
- Cause: Viewport defaulted to Prepare and shell controls were not consistently scoped by page.
- Fix: Pass `workspaceMode` explicitly; scope shortcuts, gizmos, import/context mutation paths, panels, plates, Timeline, and header actions to their owning page. Keep the viewport mounted while navigating.
- Evidence: [App.tsx](../../apps/editor/src/App.tsx), [Viewport.tsx](../../apps/editor/src/viewport/Viewport.tsx), [Toolbar.tsx](../../apps/editor/src/viewport/Toolbar.tsx), and the two editor E2E suites.

**[BUG] P1: Slice lifecycle lost during navigation**

- Symptom: Conditionally mounting the Slice component could lose in-flight state when leaving Prepare.
- Cause: Page visibility also controlled component lifetime.
- Fix: Keep Slice mounted in a hidden wrapper. Scope completion to the active project; completion while on Home must not steal navigation.
- Evidence: Delayed native-job fixture preserves the request, does not cancel, and retains Home after completion.

**[BUG] P1: Global chat invisible or duplicated**

- Symptom: Chat portaled into a hidden canvas on Home/Workbench; docking could move it into an invisible sidebar.
- Cause: A canvas-only portal root and independent sidebar/floating render conditions.
- Fix: Use a window host on non-editor pages and a canvas host in the editor; docking restores Prepare and the chat sidebar. Render sidebar chat only when docked and selected. Preserve the existing sidebar selection in Preview.
- Evidence: Single-visible-chat assertions, real collapse/reopen/dock input, and measured 366-pixel panel width in a 390-pixel viewport.

**[BUG] P1: Device controls suggested real execution through mock lanes**

- Symptom: Enabled temperatures, fans, lights, dryer, binding, files, and raw commands could imply physical operation despite mock writers.
- Cause: Capability flags were treated as transport availability.
- Fix: Explicit read-only availability policy, disabled write/camera affordances, sender guards, visible telemetry provenance, and a separately labeled Demo file catalog. Remove the mock-backed raw-command form.
- Evidence: [device-availability-core.ts](../../apps/editor/src/state/device-availability-core.ts), seven focused tests, [DevicePanel.tsx](../../apps/editor/src/panels/DevicePanel.tsx), and [DevToolsPane.tsx](../../apps/editor/src/panels/DevToolsPane.tsx).

**[BUG] P1: Narrow-screen authoring controls obscured**

- Symptom: The mobile sidebar covered the viewport toolbar; a wrapped toolbar intersected the plate rail.
- Cause: An initially open absolute-positioned sidebar and fixed rail offsets under a variable-height toolbar.
- Fix: Start/cross into the narrow breakpoint with the sidebar collapsed, preserve manual opening, keep the toolbar in a scrollable row, and anchor the rail above the plate tabs.
- Evidence: At 390 pixels, the tested toolbar is 366 by 44 pixels and does not intersect the rail. E2E scrolls each enabled toolbar button into view and checks real hit targets. The 760-pixel boundary is also covered.

**[BUG] P1: Active-label and accent-button contrast**

- Symptom: White accent-button text measured 3.25:1 in dark mode; selected workspace labels measured about 4.34-4.36:1.
- Cause: Reusing foreground tokens inappropriate for the actual composited background.
- Fix: Dark text on the dark-theme filled accent, and `--accent-strong` for active workspace/sidebar/settings/toolbar/plate text.
- Evidence: Sample contrast improves to 5.75:1 for the dark filled accent and 5.54:1 dark / 5.78:1 light for selected-label backgrounds.

**[BUG] P2: Floating-panel and notification accessibility**

- Symptom: Non-modal panels wrapped Tab indefinitely; dock controls lacked accessible names; notification disclosure state was missing.
- Cause: Modal-style keyboard handling on a non-modal surface and incomplete trigger semantics.
- Fix: Allow focus to leave, name dock controls, expose notification expanded/controlled-region state, restore bell focus on Escape, and measure drag/resize against the active host. Resize cleanup handles cancellation/unmount.

**[BUG] P2: Chat and material-binding state clarity**

- Symptom: Developer jargon and a literal placeholder appeared in empty chat; blank messages could be sent; binding fields could retain values from another object; binding copy stayed English in Portuguese.
- Cause: Development copy and unsynchronized local field state.
- Fix: Neutral labels, visible Demo/broker provenance, disabled whitespace-only send, accessible generic send error, conditional Demo hint, localized binding strings, selection-driven field reset, and stale/offline/slot guards.
- Boundary: Spool binding stores local metadata only; it does not update RFID or assign hardware.

## 4. Technical Verification

**[SPEC]**

| Check                                  | Final Result                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `pnpm run check`                       | Passed through all configured stages                                                                      |
| Formatting, ESLint, TypeScript         | Passed                                                                                                    |
| Unit tests                             | 783 passed, zero failures                                                                                 |
| Integration tests                      | 11 passed, zero failures                                                                                  |
| Rust workspaces and editor shell       | Cargo check/test passed; an external-Blender-dependent test remains explicitly ignored by the normal gate |
| MCP build/smoke                        | Build passed; 115 tools responded                                                                         |
| CAD UI, editor reload, editor Home E2E | All three passed                                                                                          |
| License gate                           | 59 direct dependencies accepted under the existing policy/allowlist                                       |
| Architecture gate                      | Passed                                                                                                    |
| Sanitizer dry-run                      | Zero files and zero substitution groups                                                                   |
| Changed editor diagnostics             | No errors                                                                                                 |

**[NOTE]**
Initial failures were not skipped: missing translation-key declarations, unformatted delegated files, a Node test importing TSX, a missing mode prop, playback-filter timing, and resize/profile-selection preconditions were repaired. Browser tests keep real pointer/keyboard input and revision checks instead of forcing clicks or weakening assertions.

## 5. Positive Findings and Design Assessment

**[SPEC]**

- The existing token system, explicit themes, compact product typography, viewport-led layout, and lazy chat loading were preserved.
- Page responsibilities now match the four-stage workflow without adding marketing content, decorative cards, or a second authoring canvas.
- Slicer presentation uses solid filament-colored materials with procedural bump/roughness; direct scene inspection found three model materials with bump maps.
- Camera preset interaction changes the actual Three.js camera. A final Top preset settled near `[0, 758.90, 0.076]` with target `[0, 0, 0]`.
- Pixel samples contained 245 distinct colors on the narrow scene and 277 on the desktop view, confirming nonblank rendering in the sampled regions.

**[?]**
No screenshot-based anti-pattern verdict is claimed. Code-level direction follows a restrained product workspace, but aesthetic quality, all glass/background contrast combinations, performance budgets, and complete touch/screen-reader coverage still need their own broader evaluation.

## 6. Limits and Follow-up

**[SPEC]**

- This review does not close the remaining CAD/mesh editing, operational AI tool loop, authenticated approvals, printer writer, camera transport, or non-planar print-qualification roadmap.
- A configured chat broker is not proof that an external model or tool execution is connected. The source label deliberately describes the transport only.
- Browser fixtures do not prove a native desktop project round-trip, cloud account availability, or a physical print.
- Smoke still reports existing Three.js CommonJS/BVH deprecation warnings. They do not fail the gate; dependency cleanup is separate from the UI review.
- No commit, push, branch change, or rollback of unrelated work was performed.

**[NOTE]**
Next review should restore the mandated vision model, inspect desktop/mobile screenshots in both themes, and run dedicated assistive-technology and performance measurements. Keep unsupported backend actions unavailable until their transports and approvals are independently validated.

## 7. Changelog

**[SPEC]**

- 1.0.2: Corrected Demo face winding, cone lighting normals, sphere poles, and boolean-result orientation; added exact exterior-ray and nondegenerate-face checks. Also synchronized Prepare navigation in the reload test against the actual active page rather than the always-mounted viewport.
- 1.0.1: Corrected Slicer edge/selection overlays, added actual-renderer browser regression, and recorded the new 781-test gate. Screenshot critique remains uncompleted.
- 1.0.0: Recorded page-context corrections, truthful capability presentation, responsive/a11y fixes, final gate evidence, and explicit validation limits.
