# S9.8-004 implementation notes — Dirty state + local persistence (G44)

Header dirty chip: unsaved ops count + last-commit time, driven by the
viewport-store revision (the SAME source the status bar uses — numbers never
disagree). Save/restore round-trips the scene through a validated backup
envelope persisted to `localStorage` — NEVER a filesystem path (AGENTS.md
golden rule: nothing machine-specific may ever be committed).

## Files

| File                        | Purpose                                                                                                                                                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state/dirty-core.ts`       | Pure headless core — `unsavedOpsDelta`, `dirtyChip`, `serializeScene`/`parseSceneBackup` (validated envelope: kind + version, structural object-name check, malformed → null), `lastCommitLabel` (mono HH:MM, "never") |
| `state/dirty.ts`            | zustand store holding ONLY the persisted baseline (`savedRevision` + `lastCommitTime`); `save`/`peek`/`restore` over `localStorage` (`anycubic:scene-backup:v1`), boot-restores the baseline from storage on load      |
| `components/dirty-chip.tsx` | Header chip: live delta via `dirtyChip(viewport.revision, savedRevision, lastCommitTime)` — dot (accent when dirty / green clean), `N unsaved`/`saved`, mono time, `save` + `restore` buttons with toast feedback      |
| `App.tsx`                   | `<DirtyChip />` mounted next to `bridge-state`                                                                                                                                                                         |
| `styles.css`                | `.dirty-chip` pill (mono, glass-fill-2, hairline), `.dirty-dot` accent/clean, buttons                                                                                                                                  |
| `tests/dirty.test.mjs`      | 6 headless tests (delta clamp, chip derivation, round-trip, garbage/foreign/version rejection, malformed fields, time label)                                                                                           |

## Behavior

- **Chip reflects unsaved revision delta**: `unsavedOps = max(0, revision - savedRevision)`;
  the delta reacts to every commit event (viewport revision is the source).
- **save**: persists `{kind, version, savedAt, revision, objects}` to localStorage;
  the saved revision becomes the new baseline (chip flips clean).
- **restore**: reads + validates the envelope, re-hydrates the scene store and
  rebases the saved point; invalid/no backup → readable toast, never a crash.
- **file never committed**: localStorage per-context, no filesystem path.

## Gate evidence

- unit: 571 (baseline) + 6 (dirty) = **577 pass / 0 fail**
- integration 11 · smoke 106 tools · licenses 59 · architecture OK
- `pnpm run check` EXIT:0 · sanitize DRY-RUN 0
