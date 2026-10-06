# UI Refactor Report — 2026-10-06 (Consultor GPT-6-Astra)

Origem: relatório `docs/ui-corrections-audit-2026-10-06.md` → consulta ao Consultor
(GPT-6-Astra) → este plano. O Consultor não inspecionou o workspace (usou o relatório
como evidência); gates ainda por correr.

---

## Avaliação do Consultor por área

| #   | Área                            | Veredicto                                                                                                                                              |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Dropdown sob canvas             | **P0 defect** — fix confirmado. Aplicar `.app-header{position:relative;z-index:40}` já; overlay refactor à parte.                                      |
| 2   | Device sem lista de impressoras | **P1** — Device deve oferecer seleção + monitor. "Sem seleção" ≠ "sem dispositivos"; descoberto/registado ≠ conectado.                                 |
| 3   | Placa grossa / objetos dentro   | **P1** correção visual + **P0 diagnostic** (verificar se é corrupção real de placement). Topo y=0 fixo; nunca compensar cosmetizando todos os objetos. |
| 4   | Sidebar Objects / transform     | **P1** correção de IA — transform junto ao canvas; settings per-objeto no sidebar.                                                                     |
| 5   | Métricas XYZ/volume sempre      | **P1** — mover para "More info" (ícone i / right-click).                                                                                               |
| 6   | Várias placas                   | **P1** discoverability — add/rename/duplicate/move já existem; multi-placa 3D simultânea é P2 separada.                                                |

Plano geral: **restaurar acesso primeiro → corrigir placa → reorganizar workflows**.
Não reconstruir discovery, transform nem multi-plate state.

---

## Work items priorizados

### P0 — Reparar layering do header

- `apps/editor/src/styles.css` → `.app-header { position:relative; z-index:40 }` (verificado no browser).
- Testar: PrinterPicker, Device toggle, shortcut-help. i18n: nenhuma.
- Aceitação: probes hit-test dentro do painel; clique seleciona; canvas não muda; Esc/focus funcionam. `toBeVisible()` não basta.
- **Commit:** `fix(editor): restore header popover stacking`

### P1-2 — Seleção de impressoras consistente

- `DevicePanel.tsx` + `DevicePanelHost.tsx` + `PrinterPicker.tsx` + `state/printers.ts(.core)`.
- Extrair `PrinterList` apresentação reutilizável; ambas superfícies consomem o mesmo discovery/selectedId/select.
- Device: lista selecionável → monitor com switcher persistente. Distinguir estados: loading, empty, discovery failure, unselected, selected-unavailable, live. Não auto-selecionar; reter stale durante refresh; dedupe refreshes; ignorar respostas obsoletas.
- i18n: `printers.select`, `printers.refresh`, `printers.discovering`, `printers.empty`, `printers.discoveryFailed`, `printers.unavailable`.
- Testes: 0/1/muitos printers, race de refresh, desaparecimento, recuperação, sync bidirecional header/Device; selecionar não envia comando de hardware.
- **Commit:** `feat(editor): expose shared printer selection in device panel`

### P1-3 — Contrato de overlays (antes de novos popups)

- Padronizar estilos/wrappers sobre Radix + `FloatingPanelHost.tsx`. Popover portalled (rich printer selection, more info), DropdownMenu (commands), ContextMenu (right-click).
- Definir layer tokens documentados (chrome / floating / transient / dialogs, incluindo popups owned by dialogs). Portal escapa do header mas não resolve layering sozinho.
- i18n: reutilizar labels. Testes: menu→dialog, docked/floating, resize, teclado, focus restoration, drag-regions.
- **Commit:** `refactor(editor): standardize overlay layering and dismissal`

### P1-4 — Afinar a placa SEM mudar coordenadas

- `BuildPlate.tsx`: preservar y=0 da superfície; UN slab fino ou camadas contíguas abaixo; feet relativos à espessura.
- Validar se Y renderizado = Z da impressora ANTES de mexer em placement. Testar cubo conhecido + mesh importada off-origin com world transforms / mesh-only bounds (excluir helpers). Se penetration real → promover import/drop-to-bed/transform a P0 e corrigir separado. Nunca reposicionar silenciosamente projetos salvos.
- Grid de referência minor/major legível por default (novas preferências), depth-tested (não atravessa objetos).
- `plate-upgrades.ts` apenas defaults de apresentação. i18n: `plate.grid`, `plate.dimensions`, `plate.profileFallback`.
- Testes: invariança de y=0, meshes rotacionadas/escaladas/off-origin, save/reload, screenshots top/oblique/side, pixels canvas não-brancos, orbit.
- **Commit:** `fix(editor): clarify build plate surface and reference grid`

### P1-5 — Identidade + specs + ações da placa

- `PlateTabs.tsx`, `BuildPlate.tsx`, `Toolbar.tsx`, styles, plates store/core.
- Ordinal separado do nome editável; IDs estáveis. Add sempre visível; rename/duplicate/move por tab.
- **DOM action rail** compacto ao lado da placa (NÃO buttons 3D raycast) — reutilizar fit view / top view / grid / plate actions; icons + tooltips.
- Especificações: largura/profundidade + alturas do perfil ativo; fallback com provenance label; nunca substituir catálogo por device descoberto. Specs renderizadas na placa com DOM equivalente p/ acessibilidade.
- i18n: `plate.number`, `plate.rename`, `plate.add`, `plate.duplicate`, `plate.specifications`, `plate.fitView`.
- Testes: rename persistence, duplicate identity, move ownership, isolamento por plate ativa, labels PT longos, overflow, mudança de perfil, rail não interage com canvas.
- **Commit:** `feat(editor): expose plate identity and quick actions`

### P1-6 — Relocalizar (não reescrever) transforms numéricos

- Rehost `TransformInspector.tsx` como painel viewport compacto aberto da Toolbar; remover mount do sidebar (owner em `App.tsx`).
- Gizmo + painel numérico partilham commands/selection/units/relative/undo. Usar FloatingPanelHost (não menu efémero — fecha durante edição numérica).
- Guard Q/W/E/R enquanto digita; Enter/Escape semantics; resolver drafts quando seleção muda.
- i18n: `transform.panel`, `transform.selectionCount`; reutilizar labels. Testes: equivalência gizmo/números, reset, relative, multi-seleção, locked, cancel, undo/redo, bridge failure.
- **Commit:** `refactor(editor): move transform editing into the viewport`

### P1-7 — Simplificar rows + promover settings de objeto

- `ObjectTree.tsx`, `ObjectSettingsPanel.tsx`, `context-menu.ts`, renderers.
- Row default: nome, filament swatch/assignment, eye, lock, overflow. Remover XYZ/footprint/volume/mesh-count PERMANENTES só quando "More info" (controlo explícito + right-click) existir; manter unidades no disclosure.
- Settings do objeto selecionado imediatamente abaixo da árvore: material, overrides suportados, modifiers suportados. Filament compacto com nome + estado inherited/explicit (não só cor); não toggle seleção; no drag.
- Ambos selectors usam `scene.mutateObject` + invalidação, pending/error. Sem segunda settings store.
- i18n: `object.moreInfo`, `object.filament`, `object.inherited`, `object.overridden`, `object.mixed`, `object.resetOverrides`, `object.updateFailed`.
- Testes: teclado na row, métricas exactas, inheritance/reset, filament indisponível, persistência, undo, failed writes, switching rápido, multi-seleção mixed.
- **Commit:** `refactor(editor): prioritize object materials and print overrides`

### P2-8 — Consolidar só contratos provados

- Printer core → shared selection/status com subs separados de monitor; plate presentation preferences em vez de mais "upgrade" flags.
- Typed per-object capability/settings boundary (scope, validation, override precedence, reset, serialization). Print settings globais NÃO devem mascarar overrides per-objeto.
- Modifiers só quando bridge + slicing/export suportarem; verificar export output, não só UI. Multi-plate 3D deferido.
- i18n: `object.unsupportedSetting`, `object.modifiers` (só implementado). Testes: pure-core precedence/capability, schema round-trips, compat projetos antigos, slicer integration.
- **Commits:** `refactor(editor): consolidate printer and plate presentation contracts` → `feat(editor): expose supported object modifiers`

---

## Estratégia de gate (para todos os commits)

1. Baseline limpo primeiro.
2. A cada edição: check mais barato → unit/component tocados → integration relevantes → Playwright afetados.
3. Antes de comitar: **`pnpm run check` completo** (unit ~687, integration 11, rust, build, e2e×2, licenses 59, arch, sanitizer 0).
4. Contagens são baseline — caso adicionem testes, subir. Atualizar docs UX/architecture + migration notes por mudança.
5. i18n: adicionar keys em `state/i18n-core.ts` + ambos dicionários (paridade EN/PT, check interpolação). Estender ficheiros de teste existentes. NO push.

## Riscos / Trade-offs (resumo)

- Persistência/safety: seleção não pode retarget print silenciosamente, mudar dimensões do projeto, nem apagar overrides. Mock discovery = evidência de teste; produção adapter verificar à parte.
- Regressões interaction/state: selectors primitivos zustand (snapshots estáveis), sem novas alocações, sem stale object targets, sem subs duplicados, sem shortcut global dentro de forms, sem click-through de portalled controls.
- Visual/native-shell: fixtures sintéticas, câmaras/fonts determinísticas, tolerâncias screenshot revistas. Validar EN/PT desktop e narrow, smoke Electron/Tauri — e2e browser não prova shell parity.
- Sem IPs reais/IDs/tokens/paths em fixtures/screenshots/docs/commits (regras do repositório).

## Fontes (seleção)

MDN stacking contexts · Radix Dropdown/Popover · three Box3 · React useSyncExternalStore · zustand#1936 · Playwright actionability/assertions/snapshots.
