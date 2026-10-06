# UI Corrections Audit — 2026-10-06

Solicitado pelo utilizador (6 queixas). Obrigatório: auditoria → Consultor (GPT-6-Astra) → plano de refactor → resumo.

---

## 1. Dropdown "No printer" aparece SOB o canvas

**Sintoma reportado:** clicar em "No printer" (header), o painel abre mas as opções ficam invisíveis/sob o canvas.

**Causa raiz (CONFIRMADA empiricamente no browser, page `127.0.0.1:1420`):**

- `.printer-picker-panel` tem `z-index: 60` e `position: absolute` — **correto**.
- Mas `.app-header` tem `backdrop-filter: blur(16px) saturate(1.15)` → **cria um stacking context** no header (o `z-index: 60` interno fica TRANCADO dentro do header).
- `.viewport-frame` tem `isolation: isolate` → também stacking context. Como `.viewport-frame` vem DEPOIS do header na ordem da árvore (sibling posterior), o conteúdo do frame (canvas + toolbar z:6) pinta POR CIMA de todo o header — incluindo o painel do picker.
- `elementFromPoint` no centro do painel aberto retornava `BUTTON.toolbar-btn`/`CANVAS` (não os filhos do painel) → confirma: o painel está renderizado mas **hit-test e paint ficam abaixo**.

**Fix verificadONO browser (injetado via JS, funcionou):**

```css
.app-header {
  position: relative;
  z-index: 40;
}
```

Com isto todos os 5 probes hit-testaram dentro do painel (`printer-picker-panel`, `printer-picker-empty`, `printer-picker-meta`, `printer-picker-refresh`).

**Arquivos:**

- `apps/editor/src/components/PrinterPicker.tsx` (online, sem bug próprio)
- `apps/editor/src/styles.css` → `.app-header` (~linha 38) e `.printer-picker(-panel)` (~2785).

**Fix proposto:** elevar o header acima do viewport-frame:

```css
.app-header {
  position: relative;
  z-index: 40;
}
```

O pc. `.device-panel-toggle` (botão Device) e o `.shortcut-help-popover` no header têm o mesmo problema potencial (qualquer dropdown/popover do header).

---

## 2. Botão "Device" diz "Nenhum dispositivo" — deveria listar as impressoras

**Sintoma:** clicar em Device mostra "No printer selected / Pick a printer in the header to see live data." — mas o utilizador espera ver a lista das impressoras descobertas.

**Causa:** `DevicePanelMonitor` (`apps/editor/src/panels/DevicePanel.tsx`) só renderiza conteúdo de monitorização quando `selectedId` (da `usePrinters` store) não é null. As impressoras DESCOBERTAS vivem da mesma store `usePrinters` (`PrinterPicker` mostra "Discovered printers" via env `ANYCUBIC_PRINTER_IPS`), mas o Device panel não as listou — apenas mostra o estado vazio.

**Arquivos:**

- `apps/editor/src/panels/DevicePanel.tsx` → branch `if (!selectedId) return <device-empty>`
- `apps/editor/src/components/dock/DevicePanelHost.tsx` (orquestra o floating/collapsed/docked)
- `apps/editor/src/components/PrinterPicker.tsx` (lista real)

**Gap de UX:** quando existem impressoras descobertas mas nenhuma selecionada, o Device panel deve (a) listá-las com LED + IP e seleção, ou (b) tornar o picker embutido, ou (c) navegar para o picker. Atualmente mostra zero contexto.

---

## 3. Placa de impressão "muito grossa" + objetos "dentro da placa"

**Sintoma:** a placa parece espessa e os objetos ficam embutidos.

**Causa/código (`apps/editor/src/viewport/BuildPlate.tsx`):**

- Top slab: `RoundedBox args={[w-2, TOP_THICKNESS=3, d-2]}` → 3mm visuais de superfície.
- Metal bed: `boxGeometry args={[w, 2.2, d]}` posicionado em `y = -1.6` → cobre de `-2.7` a `-0.5`, ou seja, o metal fica ACIMA de `y=-0.5`… na verdade o topo do bed está em `-0.5` e o RoundedBox em `[-1.5, +1.5]` → interseção visual: o bed (topo -0.5) entra DENTRO do RoundedBox (fundo -1.5). A placa fica com 2 corpos sobrepostos → parece grossa e os objetos parecem "dentro".
- Feet em `y=-3.2`.
- Linha de grade: `opacity 0.28` faint; `axesHelper` + quadrant cru.

**O que o utilizador quer:**

1. Placa mais fina / sem sobreposição (objetos repousam EM cima, não dentro).
2. Malha de referência (grid) tipo placa Anycubic (visual reference).
3. Botões laterais na placa (quick-access actions).
4. Especificações da placa escritas na superfície (se fornecidas pelo perfil/impressora).
5. Múltiplas placas + número + nome (JÁ EXISTE: `viewport/PlateTabs.tsx` + `state/plates.ts`).

**Já existe:** quadrants + front label + Z column são upgrades opt-in (`state/plate-upgrades.ts`, `Toolbar.tsx` plate-upgrades group, default OFF). A malha de referência "tipo Anycubic" ainda NÃO é a default.

---

## 4. Menu lateral "Objects": opções de transformação/manipulação fora de contexto

**Sintoma:** o utilizador gosta do menu Objects, mas acha que transformar/manipular devia estar na barra de ações (toolbar) ou em menu condensado DENTRO do canvas — e que na lista de objetos deviam estar as configurações INDIVIDUAIS do objeto (impressora/filamento/modificadores).

**Estado atual:**

- `panels/ObjectTree.tsx` — lista de objetos com: nome, meta (tri·vtx), 5 colunas de placement (X/Y/Z/footprint/volume) sempre visíveis, botões eye/lock/more.
- `panels/TransformInspector.tsx` — inspector numérico (position/rotation/scale + relative + reset) montado no sidebar.
- `panels/ObjectSettingsPanel.tsx` — JÁ EXISTE: per-object print settings + filament select + override toggle (mas numa área separada por baixo).
- `viewport/TransformGizmo.tsx` + `viewport/Toolbar.tsx` — o gizmo Move/Rotate/Scale já vive DENTRO do canvas via toolbar (Q/W/E/R + W/E/R).
- `components/context-menu-items.tsx` + `components/context-menu-core.tsx` — menu contextual partilhado (duplicate/rename/hide/delete/place/reair).

**Gap:** a duplicação de "transformação numérica" fora do canvas (TransformInspector no sidebar) — o utilizador prefere a toolbar in-canvas e/ou menu condensado. E as métricas XYZ/volume na lista deviam ir para um popup "More info" (ícone i ao lado do nome / right-click), deixando espaço para coisas úteis (filament select por objeto ao lado do nome — JÁ EXISTE no ObjectSettingsPanel, mas não junto ao nome na lista).

---

## 5. XYZ/volume sempre na lista → Popup "More info"/ícone de info

**Causa:** `ObjectTree.tsx` renderiza `object-placement` (5 células: center X/Y/Z, footprint, volume) for ALL rows sempre. O utilizador quer isso escondido atrás de "More info" (popup no ícone i / right-click), mantendo a linha limpa.

---

## 6. Filamento por objeto junto ao nome (na lista) + placas (número/nome)

- **Filamento na lista:** hoje o filamentId por objeto está no `ObjectSettingsPanel` (per-object fork + override), mas o utilizador quer um SELECT de filamento junto ao nome do objeto na lista.
- **Placas:** já existe add/rename/duplicate/move (`PlateTabs` + `plates-core`), mas falta visibilidade do NÚMERO da placa (chip "Plate 2" vem do nome). Verificar se o utilizador quer número + affordances.

---

## Evidência do browser (resumo)

| Check                             | Resultado                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `.printer-picker-panel` z-index   | 60 (trancado dentro de `.app-header` por `backdrop-filter`)                                              |
| `.viewport-frame`                 | `isolation: isolate` → stacking context posterior pinta por cima do header                               |
| elementFromPoint centro do painel | `toolbar-btn`/`CANVAS` (ANTES do fix) → todos os filhos do painel (DEPOIS do fix `z-index:40` no header) |
| Device panel sem selectedId       | `device-empty`: "No printer selected / Pick a printer in the header"                                     |
| Plate                             | TOP_THICKNESS 3 + metal bed 2.2 sobrepostos → aparência grossa                                           |

---

## Recomendações preliminares (para o Consultor validar)

1. **P0** — `.app-header { position: relative; z-index: 40 }` (fix do dropdown; verificar popovers/device igualmente).
2. **P1** — Device panel: quando `selectedId` é null mas há printers descobertas, mostrar lista (LED + IP + selecionar) em vez de estado vazio.
3. **P1** — BuildPlate: reduzir espessura visual / remover sobreposição bed×top; adicionar malha de referência default (tipo Anycubic) + specs da placa (do `OperatorProfile`/`buildVolume`) na superfície.
4. **P1** — ObjectTree: mover metrics (XYZ/footprint/volume) para popup "More info" (ícone i); remover colunas de sort por placement ou manter mas como detalhe; adicionar filament select junto ao nome (reutilizar `ObjectSettingsPanel` logic); mover TransformInspector para toolbar/menu condensado no canvas.
5. **P2** — Placas: número visível + affordances; rever visibilidade das plate-tabs.

---

## Próximos passos

- Enviar este relatório ao Consultor (GPT-6-Astra) para opinião detalhada + plano de refactor completo.
- Apresentar resumo proposto no chat (PT).
