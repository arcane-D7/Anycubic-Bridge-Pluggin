# S9.8-002 — Viewport object labels (G45) — design notas

## AC

- Chips on hover (ou always-on via toggle); seguem objetos durante transform; theme-correct.

## Decisão de arquitetura

- **Sem drei Html** (bloat + re-renders no canvas). **Dois componentes finos**:
  1. `LabelProjector` — DENTRO do Canvas (R3F). Cada frame projeta o anchor
     (bounds top-center) de cada objeto visível para NDC com `THREE.Vector3.project`
     a partir da **matrixWorld LIVE** do grupo (registado via `registerAnchorProbe` no
     SceneObjectModel). Escreve no bus mutável `state/labels.ts` + dá `bump()`.
  2. `ObjectLabels` — FORA do Canvas (irmão, igual ViewCube/NonWatertightBadges).
     Subscreve `frame`, converte NDC→CSS pixels (`ndcToViewport`), clamp (`clampChip`),
     renderiza chips glass. **Zero re-renders do canvas** para labels.
- **Bus**: `state/labels.ts` — `ndcMap` mutável (Map name→NDC), `frame` counter no
  zustand, `hoveredName` (SceneObjectModel dispara via `onHover`).

## Ficheiros

- `viewport/labels-core.ts` (puro): `statusOf`, `chipLabel`, `ndcToViewport`, `clampChip`.
- `state/labels.ts` (bus).
- `viewport/Labels.tsx`: `LabelProjector` (in-canvas) + `ObjectLabels` (overlay).
- `viewport/SceneObjectModel.tsx`: regista probe (bounds top-center + 4mm), `lockedRef`,
  mesh hover → `useLabelsBus.setHovered`.
- `viewport/Toolbar.tsx`: toggle always-on (`toggle-labels`, ícone `eye`).
- `state/ui.ts`: `objectLabelsAlwaysOn` + toggle.
- `tests/labels.test.mjs` (6 casos): statusOf precedence, chipLabel, ndcToViewport
  (y-flip), clampChip, compose perto das bordas.

## Lições

- `import type * as THREE` não pode ser usado como value → `import * as THREE`.
- O hover dos meshes já tinha `setHovered` local; para os chips precisamos estado
  global → `useLabelsBus.setHovered` (nome) + `lockedRef` (não-mostrar chip locked).

## Gate

- Round 1 async `$env:TEMP\s9-8-002-check1.log` (GATE_EXIT esperado 0).
