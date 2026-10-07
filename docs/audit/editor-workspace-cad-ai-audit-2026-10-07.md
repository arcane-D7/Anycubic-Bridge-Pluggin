# Auditoria integral do editor: workspace, CAD, slicing, impressoras e AI

**Version 1.0.0** · GitHub Copilot · 2026-10-07 · HADS 1.0.0

| Campo                   | Valor                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Estado                  | Diagnóstico documentado; direção de implementação proposta; correções não executadas por este documento                                                           |
| Baseline observado      | `5433b78`; repositório limpo antes da criação deste guia                                                                                                          |
| Origem                  | Auditoria de 2026-10-07 solicitada pelo utilizador, seguida de pedido para guardar um guia extremamente detalhado para agentes                                    |
| Público                 | Agentes de investigação, implementação, diagnóstico, validação e revisão; responsáveis pelo produto                                                               |
| Superfícies             | Home, Prepare, Preview, Workbench, chat interno, CAD, menu contextual, materiais, barras, scrollbars, jobs e transportes                                          |
| Validação realizada     | Leitura dos caminhos de código implicados; inspeção DOM; medições geométricas no browser; probes de funções puras; comparação com fontes oficiais                 |
| Validação não realizada | Reparação geométrica real, slicing real da cena, envio/execução física, avaliação completa de contraste, benchmark de desempenho ou paridade integral com Blender |
| Regra de interpretação  | Uma proposta neste documento não deve ser apresentada como funcionalidade já implementada                                                                         |
| Escopo desta entrega    | Um documento; sem mudanças no código da aplicação, sem novas sprints, sem commit ou push                                                                          |

---

## AI READING INSTRUCTION

**[SPEC]**

- Ler primeiro as secções 1, 2, 4, 5, 6, 17, 18 e 19.
- Ler todos os blocos `[BUG]` relevantes ao domínio antes de implementar.
- `[SPEC]` distingue regras existentes, requisitos do utilizador e contratos-alvo. O título da secção e a coluna de estado determinam se algo é atual ou proposto.
- A palavra **DEVE** num contrato-alvo estabelece um critério para a implementação futura; não descreve a entrega atual.
- `[BUG]` descreve sintoma, causa/evidência e correção **proposta**. Nenhuma correção é aplicada automaticamente por ler o bloco.
- `[NOTE]` fornece contexto e justificação; não prevalece sobre políticas do repositório.
- `[?]` assinala hipótese, limitação ou decisão por verificar; nunca converter em facto sem evidência.
- Respeitar [AGENTS.md](../../AGENTS.md), [política de licenças](../licenses.md) e instruções locais aplicáveis. Este guia não concede permissões de execução física, de acesso a segredos ou de alteração de arquitetura fora do trabalho autorizado.
- Revalidar os anchors no checkout atual. A baseline de 2026-10-07 não é uma garantia de que o código permaneceu igual.
- Não ler todo o documento em cada tarefa: localizar o achado e domínio, confirmar dependências, executar a menor alteração verificável e regressar aos critérios de aceitação.
- Não criar agentes, trocar modelos ou delegar trabalho apenas porque este documento menciona responsabilidades. Seguir as regras de delegação da sessão.
- Não criar novas sprints ou renumerar as existentes a partir deste documento sem uma tarefa de planeamento autorizada.
- Ao declarar um resultado, distinguir Demo, teste unitário, integração de backend, E2E de produto e evidência física.

## Índice de navegação

| Secção | Conteúdo                               | Quando consultar                               |
| ------ | -------------------------------------- | ---------------------------------------------- |
| 1      | Parecer executivo                      | Antes de decidir prioridades                   |
| 2      | Requisitos e cobertura                 | Antes de aceitar ou fechar uma entrega         |
| 3      | Método, fontes e limites               | Ao verificar confiança das conclusões          |
| 4      | Inventário atual e anchors             | Antes de procurar a implementação              |
| 5      | Achados AUD-01 a AUD-15                | Antes de corrigir um comportamento             |
| 6      | Arquitetura, autoridade e contratos    | Antes de alterar providers, stores ou execução |
| 7      | Home / Prepare / Preview / Workbench   | Antes de reorganizar navegação e páginas       |
| 8      | Menu contextual                        | Antes de alterar picking, âncora ou ações      |
| 9      | Barras, placa e overlays               | Antes de alterar layout do canvas              |
| 10     | Mesh, Slicer e materiais               | Antes de alterar apresentação ou binding       |
| 11     | Slicing e artefactos                   | Antes de ligar o pipeline real                 |
| 12     | Preview técnico e reprodução           | Antes de ampliar IR, filtros ou playback       |
| 13     | CAD e paridade de mesh                 | Antes de acrescentar operações de edição       |
| 14     | Workbench e comandos físicos           | Antes de alterar integração de impressoras     |
| 15     | Chat, tools e aprovações               | Antes de conceder execução ao agente           |
| 16     | Scrollbars, acessibilidade e i18n      | Antes de fechar consistência visual            |
| 17     | Sprints e sequência de integração      | Antes de escolher o próximo domínio            |
| 18     | Protocolo de trabalho para agentes     | Antes de implementar e antes de entregar       |
| 19     | Matriz de testes e definição de pronto | Antes de validar ou marcar como Done           |
| 20     | Decisões pendentes e riscos            | Antes de ampliar o escopo                      |
| 21     | Referências e manutenção               | Ao verificar uma fonte ou atualizar o guia     |

## 1. Parecer executivo

**[SPEC]**

- O problema central é de **integração e autoridade de execução**, não apenas de estilo.
- Existem componentes, contratos, bibliotecas e backends úteis. A recomendação é ligá-los, não reconstruir o produto do zero.
- O editor observado usa um provider demonstrativo diretamente em caminhos que a UI apresenta como operações do produto.
- Um indicador de sucesso, uma mudança de flag ou um teste verde de presença de elementos não prova a operação geométrica/física anunciada.
- O destino de produto requerido é `Home -> Prepare -> Preview -> Workbench`, com chat disponível e contexto coerente em todas as páginas.
- Todas as operações públicas devem ter ligação e visibilidade no chat através de tools de domínio, sujeitas à mesma política da UI.
- O caminho mais conciso é: uma autoridade de projeto, um catálogo partilhado de operações, backends explicitamente selecionados e testes de fluxo real.

**[NOTE]**
As correções recentes do bell, dock e affordance de repair resolvem partes da interação visual. Não eliminam o facto de que o editor ainda pode simular slice, booleanos, repair e comandos. É necessário preservar esses ganhos de UX e completar a ligação operacional.

### 1.1 Correção de uma conclusão anterior

**[SPEC]**

- A validação anterior de Auto-repair confirmou `trigger -> popover -> ação -> alteração de estado -> affordance desaparece`.
- Não confirmou uma reparação real da malha.
- Na baseline, o provider mock conserva os buffers de geometria ao alterar `watertight`.
- Agentes não devem reutilizar o relatório anterior como evidência de fechamento de buracos, remoção de non-manifold ou correção de normais.
- A aceitação de repair exige execução num backend real e validação independente do resultado geométrico.

### 1.2 Prioridade de produto

| Ordem | Prioridade | Resultado requerido                                | Motivo                                                           |
| ----- | ---------- | -------------------------------------------------- | ---------------------------------------------------------------- |
| 1     | P0         | Tornar explícito Demo versus execução real         | Evitar afirmações de sucesso sem artefacto/efeito correspondente |
| 2     | P0         | Autoridade de cena, revisões e provider real       | Suporta CAD, undo, materiais, slicing e tools                    |
| 3     | P0         | Slice da cena atual produz IR/programa/Preview     | Fecha o fluxo principal de fabricação                            |
| 4     | P0         | Chat com execução real e aprovação backend         | Fecha o objetivo de controle profundo por AI                     |
| 5     | P0         | Comandos físicos reais, validados e observáveis    | Evita confundir leitura cloud com capacidade de escrita          |
| 6     | P1         | Menu contextual por alvo, junto do clique          | Corrige interação básica e expõe operações existentes            |
| 7     | P1         | Layout responsivo e responsabilidades das barras   | Elimina controles escondidos e redundantes                       |
| 8     | P1         | Materiais por objeto e apresentação Slicer correta | Evita aparência e plano de filamento inconsistentes              |
| 9     | P1         | Quatro páginas e CAD avançado por contratos        | Organiza o produto sem duplicar autoridade                       |
| 10    | P1/P2      | Aceitação E2E, i18n, acessibilidade e scrollbars   | Evita repetir entregas visualmente presentes mas inacessíveis    |

## 2. Requisitos do utilizador e cobertura

**[SPEC]**
Os IDs abaixo identificam requisitos desta auditoria, não novos tickets de sprint.

| ID  | Requisito                                                   | Direção neste guia      | Aceitação principal                 |
| --- | ----------------------------------------------------------- | ----------------------- | ----------------------------------- |
| R01 | Menu junto do ponto onde foi feito o clique direito         | Secção 8; AUD-01        | CTX-01 a CTX-04                     |
| R02 | Ações dependentes do objeto, placa, fundo e modo            | Secção 8; AUD-02        | CTX-05 a CTX-10                     |
| R03 | Editar, atribuir filamento, assentar, reparar e clonar      | Secções 8, 10 e 13      | CAD-01 a CAD-08; MAT-01 a MAT-05    |
| R04 | Criar partes, modificadores e volumes negativos             | Secção 13               | CAD-09 a CAD-13                     |
| R05 | Eliminar sobreposição das barras                            | Secção 9; AUD-03        | UI-01 a UI-04                       |
| R06 | Eliminar repetição indevida de Fit, Top e Grid              | Secção 9                | UI-05 a UI-07                       |
| R07 | Controles exclusivos da placa acima dos tabs inferiores     | Secção 9                | UI-08                               |
| R08 | Informação da placa por botão `(i)` e popup                 | Secções 7 e 9           | UI-09 e UI-10                       |
| R09 | Mesh e Slicer visualmente distintos                         | Secção 10; AUD-04       | MAT-01 e MAT-02                     |
| R10 | Sólidos com cor e textura do filamento do objeto            | Secção 10; AUD-05       | MAT-03 a MAT-08                     |
| R11 | Live fora do Prepare e acessível em Workbench               | Secções 7 e 14          | NAV-04; DEV-08 e DEV-09             |
| R12 | Slice gera preview e navega para Preview                    | Secções 11 e 12; AUD-06 | SLC-01 a SLC-08                     |
| R13 | Home com contexto geral e históricos                        | Secção 7                | NAV-01; HIS-01 a HIS-04             |
| R14 | Prepare dedicado à autoria/edição                           | Secções 7 e 13          | NAV-02; CAD-01 a CAD-13             |
| R15 | Preview técnico e passo a passo                             | Secção 12               | PRV-01 a PRV-10                     |
| R16 | Workbench com impressoras, filamentos, controle e progresso | Secção 14               | DEV-01 a DEV-11                     |
| R17 | Scrollbars coerentes com o design                           | Secção 16               | SCR-01 a SCR-05                     |
| R18 | Edição de mesh comparável às operações do Blender           | Secção 13               | CAD-06 a CAD-16; matriz de paridade |
| R19 | Ligação/visibilidade de todas as operações no chat          | Secção 15               | AI-01 a AI-10                       |
| R20 | Considerar sprints concluídas e pendentes                   | Secção 17               | DOC-01 a DOC-03                     |

### 2.1 O que este guia não autoriza

**[SPEC]**

- Não autoriza copiar código de projetos incompatíveis com a política de licenças.
- Não autoriza remover confirmação de ações físicas para cumprir a expressão “controle absoluto”.
- Não autoriza aquecer, mover, alimentar filamento, secar, carregar ficheiros ou iniciar/cancelar impressões durante uma auditoria de leitura.
- Não autoriza trocar de stack, renumerar sprints, fazer commits/pushes ou apagar trabalho alheio.
- Não autoriza declarar recursos não planares ou multi-axis como prontos antes dos seus gates específicos.

## 3. Método, evidência e limites

**[SPEC]**

- A auditoria transversal seguiu os caminhos que controlam os comportamentos pedidos.
- O método combinou leitura de implementação, leitura de testes, inspeção do browser e probes determinísticos sem escrita de ficheiros.
- Não foi executado um health gate novo durante a auditoria original: parte do gate gera artefactos e o pedido era de leitura apenas.
- A ausência de erros num reload não substitui os critérios de produto desta auditoria.
- Não foi feito um scan de segurança completo de todos os binários, endpoints ou dependências.
- Nenhuma captura com dados privados ou payload de conta foi incluída neste documento.
- Medidas em pixels abaixo são evidência de uma sessão de browser, não defaults de layout para outras máquinas.

### 3.1 Classes de confiança

| Classe | Significado                               | Uso permitido                                                      |
| ------ | ----------------------------------------- | ------------------------------------------------------------------ |
| C1     | Confirmado por execução/medição na sessão | Pode fundamentar uma reprodução, com revalidação no checkout atual |
| C2     | Confirmado por inspeção de código/teste   | Pode fundamentar hipótese local e teste discriminante              |
| C3     | Proposta de arquitetura ou UX             | Exige implementação e testes; não anunciar como entregue           |
| C4     | Hipótese/risco ainda não medido           | Reproduzir antes de alterar ou afirmar causa                       |

### 3.2 Probes discriminantes executados

| Evidência | Observação                                                                    | Conclusão limitada                                                       |
| --------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| E-P01     | Clique do canvas aproximadamente `(516, 290)`; menu em `(8, 8)`               | A âncora do caller não é respeitada na sessão                            |
| E-P02     | Helper sem viewport devolve `(8, 8)`; com viewport devolve o ponto solicitado | A falta de dimensões explica o deslocamento reproduzido                  |
| E-P03     | Toolbar com largura aproximada de 1219 px; plate rail com cerca de 374 px     | Controles competem pela mesma faixa horizontal                           |
| E-P04     | Janela de 1743 px: sobreposição horizontal de cerca de 292 px                 | Layout falha mesmo numa janela larga                                     |
| E-P05     | Janela de 1280 px: toolbar ultrapassa o frame; rail sobreposta                | Há um defeito estrutural de responsividade                               |
| E-P06     | Janela de 1024 px: frame/layout podem exceder a janela                        | Precisa verificar shrink/min-width no shell, não só reposicionar overlay |
| E-P07     | Pedido explícito PETG resolvido para slot carregado PLA num input sintético   | Fallback pode sobrepor a escolha explícita                               |
| E-P08     | Containers medidos com `scrollbar-color: auto` e `scrollbar-width: auto`      | Não há tema aplicado nesses containers                                   |

**[?]**

- O utilizador observou o menu no canto superior direito; nesta sessão apareceu no esquerdo. Não afirmar que ambos têm exatamente a mesma causa sem reproduzir a variante atual.
- A distorção visual da textura tem causas plausíveis no caminho de UV/material, mas não foi quantificada por benchmark ou comparação fotométrica.
- A divergência de eixos no código precisa ser confrontada com a semântica efetiva do payload de telemetria antes de escolher a conversão final.

## 4. Inventário atual e anchors

**[SPEC]**
Os links apontam para ficheiros existentes na baseline. A linha exata pode mudar; procurar os símbolos indicados antes de editar.

| Área             | Anchor                                                                                                                                                               | Estado observado                                                  | Reutilização recomendada                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Shell            | [App.tsx](../../apps/editor/src/App.tsx): `workspaceView`, `previewIr`, `onIrFile`                                                                                   | Prepare/Preview locais; Preview derivado de IR importado          | Extrair responsabilidades de página sem duplicar contexto de projeto    |
| Menu visual      | [ContextMenu.tsx](../../apps/editor/src/components/ContextMenu.tsx)                                                                                                  | Portal no body, coordenadas fixas, teclado manual                 | Preservar contrato de abertura; melhorar apresentação/acessibilidade    |
| Menu puro        | [context-menu-core.ts](../../apps/editor/src/components/context-menu-core.ts): `openContextMenuAt`                                                                   | Clamp por viewport opcional, com zero quando ausente              | Corrigir contrato e cobrir callers reais                                |
| Ações de menu    | [context-menu-items.ts](../../apps/editor/src/components/context-menu-items.ts)                                                                                      | Builders por árvore/placa; labels ingleses                        | Migrar para catálogo de ações e i18n                                    |
| Picking          | [SceneObjectModel.tsx](../../apps/editor/src/viewport/SceneObjectModel.tsx)                                                                                          | Context menu apenas interrompe propagação                         | Resolver alvo e encaminhar contexto de domínio                          |
| Fundo do canvas  | [Viewport.tsx](../../apps/editor/src/viewport/Viewport.tsx): `onFrameContextMenu`                                                                                    | Menu genérico; algumas ações apenas notificam                     | Ligar aos mesmos handlers que as ações reais                            |
| Toolbar          | [Toolbar.tsx](../../apps/editor/src/viewport/Toolbar.tsx)                                                                                                            | Barra extensa centrada, responsabilidades misturadas              | Reduzir e organizar por modo/contexto                                   |
| Placa            | [PlateRail.tsx](../../apps/editor/src/viewport/PlateRail.tsx) e [PlateTabs.tsx](../../apps/editor/src/viewport/PlateTabs.tsx)                                        | Rail superior direita; tabs de placa                              | Compor uma zona inferior da placa                                       |
| Render           | [SceneObjectModel.tsx](../../apps/editor/src/viewport/SceneObjectModel.tsx)                                                                                          | Sólido + arestas globais; material condicional                    | Resolver apresentação por modo e binding explícito                      |
| Cor/material     | [material-assign-core.ts](../../apps/editor/src/state/material-assign-core.ts)                                                                                       | Match por material e fallback carregado                           | Separar material de projeto de slot físico                              |
| Textura          | [filament-material.ts](../../apps/editor/src/viewport/filament-material.ts)                                                                                          | Bump/roughness procedural                                         | Usar projeção válida, cache e lifecycle de GPU                          |
| Cena/mock        | [mock.ts](../../apps/editor/src/bridge/mock.ts): `snapshot`, `fetchSceneSnapshot`                                                                                    | Demo e simulações in-process                                      | Conservar para testes/Demo, não como execução silenciosa de produto     |
| Contrato de cena | [types.ts](../../apps/editor/src/bridge/types.ts)                                                                                                                    | Triangle buffers, transform, filament, parent e plate opcionais   | Evoluir por versão para identidade, volumes, binding e capabilities     |
| Slice UI         | [SliceButton.tsx](../../apps/editor/src/components/SliceButton.tsx)                                                                                                  | Progressão simulada e estatísticas                                | Consumir job/eventos reais                                              |
| IR backend       | [slice-ir.mjs](../../scripts/slice-ir.mjs)                                                                                                                           | Speed, flow, bead, cooling e validação                            | Preservar no contrato consumido pela UI                                 |
| IR frontend      | [ir.ts](../../apps/editor/src/bridge/ir.ts)                                                                                                                          | Parser de um subset mais reduzido                                 | Evoluir com validação de versão/capacidades                             |
| Preview model    | [preview-model.ts](../../apps/editor/src/viewport/preview-model.ts)                                                                                                  | Paths por camada; subset reduzido                                 | Acrescentar ordem/IDs/atributos sem inventar dados                      |
| Preview render   | [LayerPreview.tsx](../../apps/editor/src/viewport/LayerPreview.tsx)                                                                                                  | Lines por WALL/INFILL/outros                                      | Classificação completa e reprodução eficiente                           |
| Drop             | [transform-core.ts](../../apps/editor/src/viewport/transform-core.ts) e [arrange-core.ts](../../apps/editor/src/state/arrange-core.ts)                               | Bounds locais/escala; operações de centrar e assentar             | Generalizar para geometria avaliada e referenciais explícitos           |
| Dispositivo UI   | [DevicePanel.tsx](../../apps/editor/src/panels/DevicePanel.tsx)                                                                                                      | Monitor/filamentos/ficheiros; writers mock                        | Rehost em Workbench e ligar provider real                               |
| Cloud            | [cloud-bridge.mjs](../../scripts/cloud-bridge.mjs) e [cloud.ts](../../apps/editor/src/bridge/cloud.ts)                                                               | Descoberta/diagnóstico cloud                                      | Preservar leitura e acrescentar comando aprovado por boundary dedicado  |
| Controle         | [printer-control.ts](../../apps/editor/src/state/printer-control.ts)                                                                                                 | Valida envelope e consome lane recebida                           | Ligar a lane real e confirmar efeito observado                          |
| Envio            | [PrintJobDialog.tsx](../../apps/editor/src/dialogs/PrintJobDialog.tsx)                                                                                               | Aprovação UI sobre stats; send mock                               | Vincular artefacto/dispositivo e autorização backend                    |
| Chat UI          | [ChatPanel.tsx](../../apps/editor/src/panels/ChatPanel.tsx) e [ChatThread.tsx](../../apps/editor/src/panels/ChatThread.tsx)                                          | Conversas + texto; tool parts não apresentados                    | Chat operacional com chamadas/resultados/aprovações                     |
| Chat transport   | [chat-transport.ts](../../apps/editor/src/bridge/chat-transport.ts) e [vite.config.ts](../../apps/editor/vite.config.ts)                                             | Gate env de broker sem exposição dessa env no Vite                | Corrigir configuração sem expor chaves                                  |
| Broker chat      | [lib.rs](../../crates/broker-server/src/lib.rs): `chat_handler`                                                                                                      | Eco offline, `_egress` não utilizado                              | Ligar provider/harness/tool loop                                        |
| Policy           | [capability-surface.ts](../../apps/editor/src/state/capability-surface.ts)                                                                                           | Policy de impressora partilhada                                   | Ampliar por domínios sem duplicar autorização                           |
| Tools MCP        | [printer-agent-tools.mjs](../../scripts/printer-agent-tools.mjs)                                                                                                     | Snapshot + oito writers tipados, confirmações por argumento       | Adaptar ao chat com aprovação autenticada backend                       |
| Blender IPC      | [ipc.rs](../../crates/blender-bridge/src/ipc.rs)                                                                                                                     | Revisão, remap, seleção e lifecycle                               | Autoridade real de execução e resposta                                  |
| Geometry proxy   | [proxy.rs](../../crates/harness-core/src/proxy.rs)                                                                                                                   | Registry/trait + stub de worker                                   | Ligar worker real; não confundir testes de contrato com mesh processada |
| Tauri            | [lib.rs](../../apps/editor/src-tauri/src/lib.rs)                                                                                                                     | Commands de app/chat-store; sem command surface de geometria aqui | Boundary de transporte explícito para provider real                     |
| Scroll           | [styles.css](../../apps/editor/src/styles.css), [index.css](../../apps/editor/src/index.css), [scroll-area.tsx](../../apps/editor/src/components/ui/scroll-area.tsx) | Containers nativos; componente reutilizável existente             | Tema global e uso seletivo do componente                                |
| E2E              | [editor-reload.e2e.mjs](../../tests/e2e/editor-reload.e2e.mjs)                                                                                                       | Presença/estado; parte dos cliques via DOM                        | Validar input real e não contornar sobreposição                         |

## 5. Achados detalhados

### AUD-01. Âncora incorreta do menu contextual

**[BUG]**

- Prioridade: P1. Confiança: C1/C2.
- Sintoma: menu abre num canto em vez do ponto do clique.
- Causa: `openContextMenuAt` usa viewport opcional; ausência equivale a dimensões zero e reduz `x/y` à margem.
- Evidência: E-P01/E-P02; callers do frame e da árvore não fornecem dimensões.
- Impacto: utilizador perde associação espacial entre objeto e ação; menus junto de bordas são imprevisíveis.
- Fix proposto: separar captura de âncora de collision handling; fornecer viewport real; medir conteúdo e respeitar CSS pixels.
- Check mínimo: clique central num caller real mantém coordenadas do clique quando há espaço.
- Regressão obrigatória: centro, quatro bordas/cantos, resize, zoom, scroll e teclado.
- Não fazer: offsets de compensação, coordenadas de ecrã, DPR multiplicado ou z-index como “fix”.

### AUD-02. Contexto e execução das ações divergentes

**[BUG]**

- Prioridade: P1. Confiança: C2.
- Sintoma: menu do canvas não oferece as mesmas ações do objeto na árvore; ações genéricas não executam o anunciado.
- Causa: mesh não abre o menu por alvo; frame constrói itens locais; árvore mantém handlers próprios; Arrange/Measure do frame só publicam mensagens.
- Evidência: `SceneObjectModel.onContextMenu`, `ViewportFrame.onFrameContextMenu`, `buildObjectMenuItems`.
- Impacto: um utilizador precisa conhecer uma superfície específica para descobrir uma operação; chat e atalhos também podem divergir.
- Fix proposto: contexto tipado de alvo/seleção + registry de ações partilhado entre superfícies.
- Check mínimo: mesma peça, mesma ação, mesmo resultado via árvore e canvas.
- Regressão obrigatória: objeto bloqueado, multi-select, parte filha, modo edit, placa vazia e Preview.
- Não fazer: um menu de objeto gigante sempre visível no fundo ou duplicação da lógica CRUD em cada componente.

### AUD-03. Sobreposição das barras e semântica de Fit

**[BUG]**

- Prioridade: P1. Confiança: C1/C2.
- Sintoma: uma barra esconde controles da outra; Fit/Top/Grid repetidos.
- Causa: toolbar extensa centrada e rail independente na mesma faixa superior; largura insuficiente e responsabilidades sobrepostas.
- Evidência: E-P03 a E-P06; PlateRail dispara o mesmo evento de enquadramento selecionado que a toolbar.
- Impacto: cliques interceptados, excesso de informação e comportamento de Fit sem alvo claro.
- Fix proposto: toolbar de autoria única no topo; controls exclusivos da placa acima dos tabs inferiores; info sob popup `(i)`; distinguir `fitSelection`, `fitPlate` e `fitAll`.
- Check mínimo: nenhum rect de controle prioritário sobrepõe outro a 1280 px; Fit plate enquadra a placa mesmo com um objeto selecionado.
- Regressão obrigatória: sidebar redimensionada/recolhida, zoom, idioma com labels maiores e Preview com sliders.
- Não fazer: esconder a barra atrás da outra, elevar z-index ou definir um offset dependente da largura medida nesta máquina.

### AUD-04. Apresentação Mesh/Slicer indistinta

**[BUG]**

- Prioridade: P1. Confiança: C2.
- Sintoma: Slicer continua a mostrar arestas/malha e não parece um sólido de fabricação.
- Causa: edges são controladas globalmente sem relação suficiente com o modo; material/apresentação/seleção não formam uma decisão coesa.
- Evidência: `SceneObjectModel` renderiza `lineSegments` quando `sceneViewEdges` está ativo, independentemente de Slicer.
- Impacto: o utilizador não percebe a diferença entre inspeção de mesh, aparência de material e preview de percursos.
- Fix proposto: resolver apresentação por modo e overlays; sólido opaco no Slicer, arestas opcionais de diagnóstico, seleção por contorno.
- Check mínimo: alternar Mesh/Slicer modifica só apresentação, não geometria, seleção, revisão ou artefactos.
- Não fazer: definir `watertight` por aparência sólida ou chamar à apresentação Slicer um resultado fatiado.

### AUD-05. Binding de filamento, updates e textura

**[BUG]**

- Prioridade: P1. Confiança: C1/C2.
- Sintoma: cores não acompanham corretamente o filamento por objeto; textura pode não ter variação espacial válida.
- Causa: matching por label/material com fallback para loaded slot; `getState()` sem subscrição; geometry builder não fornece UVs para o caminho de mapas.
- Evidência: E-P07; `matchAceSlot`, `resolveFilamentColor`, `geometryFromBuffers`, `filamentMaterial`.
- Impacto: projetos multicolor podem ter aparência diferente da atribuição escolhida; telemetria não atualiza corretamente a apresentação.
- Fix proposto: ID estável de material de projeto, binding físico separado e explícito, subscrição seletiva e projeção UV/triplanar adequada.
- Check mínimo: PETG explicitamente atribuído não é substituído por um PLA carregado sem binding aprovado.
- Regressão obrigatória: dois rolos PLA de cores distintas, impressora offline, troca de impressora, reload e material unassigned.
- Não fazer: usar o primeiro slot ocupado/carregado como correspondência universal ou recalcular todos os objetos a cada poll.

### AUD-06. Slice desconectado do artefacto e Preview

**[BUG]**

- Prioridade: P0. Confiança: C2.
- Sintoma: Slice apresenta conclusão, mas não abre o Preview da cena atual.
- Causa: UI usa estágios simulados e lane de estimativa; `previewIr` é alimentado por import manual e não pelo resultado do job.
- Evidência: `SliceButton.runStages`, `mock.slice`, `App.onIrFile`, `buildPreviewModel`.
- Impacto: fluxo de fabricação principal fica incompleto e “ready” não significa output imprimível.
- Fix proposto: job real produz IR/programa/metadata, valida artefactos e só então publica ready e navega para Preview.
- Check mínimo: um modelo importado e posicionado na placa produz Preview sem fornecer um JSON manual.
- Regressão obrigatória: falha, cancelamento, resposta tardia, alteração de settings durante job, troca de placa e resultado stale.
- Não fazer: navegar para um preview antigo ou renderizar linhas inventadas a partir de volume/bounding box.

### AUD-07. Repair e booleanos simulados

**[BUG]**

- Prioridade: P0. Confiança: C2.
- Sintoma: UI anuncia geometria reparada ou combinação de peças sem executar o processamento correspondente.
- Causa: mock de repair conserva geometry; mock boolean fabrica uma fixture de resultado.
- Evidência: `mock.repair`, `mock.boolean`, `booleanResultGeometry`.
- Impacto: malhas inválidas podem passar preflight pela flag; utilizador acredita numa alteração que não existe na geometria.
- Fix proposto: separar Demo e real; chamar worker/kernel selecionado; validar topologia e devolver novo mesh/artifact digest.
- Check mínimo: mesh com defeito deliberado apresenta mudança geométrica comprovada ou recusa honesta com diagnóstico.
- Regressão obrigatória: fontes de boolean mantidas/ocultas, undo, volume, transform, materiais, falha de worker e limites de tamanho.
- Não fazer: trocar apenas `watertight`, contagem de vértices/triângulos ou provenance para anunciar repair.

### AUD-08. Autoridade de revisão e journal fragmentada

**[BUG]**

- Prioridade: P1, bloqueador de integração de produto. Confiança: C2.
- Sintoma: revisões e journal do handle não representam de forma persistente todas as alterações da cena.
- Causa: `snapshot()` fornece revisão fixa; `fetchSceneSnapshot()` recria estado local de revisão/journal; alguns CRUDs não seguem uma transação autoritativa única.
- Evidência: `mock.snapshot`, `fetchSceneSnapshot`, `mutateObject`, `commit`.
- Impacto: artefactos stale, undo, seleção e AI podem tomar decisões sobre uma revisão errada.
- Fix proposto: sessão/project authority persistente com revisão monotónica, expectedRevision, resultados autoritativos e journal de operações reais.
- Check mínimo: duas operações e dois refetches preservam a revisão atual e o histórico de ambas.
- Regressão obrigatória: edição UI e tool concorrentes, rename, duplicate, reset, reopen, crash recovery e no-op.
- Não fazer: incrementar revisão separadamente em cada store ou considerar um reload do query como rollback.

### AUD-09. Chat em eco e tool loop ausente

**[BUG]**

- Prioridade: P0. Confiança: C2.
- Sintoma: chat não controla a aplicação por tools de domínio.
- Causa: frontend apresenta só text parts; broker responde eco; registry de execução/harness não está ligado ao caminho observado.
- Evidência: `ChatThread`, `chat_handler`, `sse_body_for`, `createMockChatTransport`.
- Impacto: existência de tools MCP externas e approval types não satisfaz o objetivo de agente interno operacional.
- Fix proposto: provider real, catálogo filtrado por política/contexto, loop de tools, resultados estruturados e UI de aprovação/progresso.
- Check mínimo: pedir uma seleção/navegação reversível provoca a mesma ação observável que a UI e apresenta resultado no transcript.
- Regressão obrigatória: tool desconhecida, indisponível, argumentos inválidos, revogada, erro de provider e troca de projeto.
- Não fazer: executar texto do modelo como código ou anunciar “feito” apenas porque o assistente respondeu.

### AUD-10. Configuração do transporte de chat inacessível no Vite

**[BUG]**

- Prioridade: P1. Confiança: C2.
- Sintoma: definir a env de broker pode não ativar a lane no frontend.
- Causa: o código consulta `ANYCUBIC_BROKER_URL`, mas a allowlist `envPrefix` não a inclui.
- Evidência: `chat-transport.brokerLaneConfigured`, `vite.config.envPrefix`.
- Impacto: deploy fica no mock sem a ligação pretendida.
- Fix proposto: expor apenas configuração pública necessária ao transporte; preferir bootstrap runtime seguro quando aplicável.
- Check mínimo: testar bootstrap com endpoint público configurado e sem expor nenhuma chave/token.
- Regressão obrigatória: Tauri e browser dev; endpoint ausente; URL inválida; backend morto; CSP/CORS e origem.
- Não fazer: expor todo o prefixo `ANYCUBIC_`, usar endpoint de provider remoto na webview ou guardar segredo no frontend.

### AUD-11. Leituras reais, controle e envio mock

**[BUG]**

- Prioridade: P0. Confiança: C2.
- Sintoma: uma impressora pode mostrar dados cloud, mas controles/ficheiros/envio continuam na simulação.
- Causa: gateway cloud observado é de leitura; writers do DevicePanel/PrintJobDialog importam o mock.
- Evidência: `cloud-bridge`, `useControlSender`, `FilesTab`, `PrintJobDialog.runSend`.
- Impacto: confirmação UI não prova upload, ordem ou efeito físico.
- Fix proposto: provider de dispositivo explícito com reads/writes suportados, execução por boundary autenticado, ACK e confirmação por leitura.
- Check mínimo: teste integrado com transport stub confirma o comando real correto sem enviar a equipamento; teste físico apenas com autorização específica.
- Regressão obrigatória: offline, timeout, auth expirada, capability desconhecida, troca de printer durante aprovação, ACK recusado e retries.
- Não fazer: afirmar “imprimiu” porque a API aceitou ou transformar um perfil declarado numa ligação física confirmada.

### AUD-12. Aprovação declarada não equivale a consentimento autenticado

**[BUG]**

- Prioridade: P0 antes de ligar o agente a writers físicos. Confiança: C2 sobre o gate observado.
- Sintoma: a documentação anuncia approval card, mas a função de gate observada verifica argumentos de confirmação.
- Causa: `confirm:true`/`confirm_word` são valores fornecidos ao tool; não são, isoladamente, prova de uma decisão humana autenticada vinculada ao payload.
- Evidência: `assertAgentApproval` em `printer-agent-tools`.
- Impacto: ligar um tool loop diretamente aos writers sem authority adicional não cumpre o contrato de consentimento pretendido.
- Fix proposto: manter confirmações como defesa adicional, mas exigir approval backend opaco, de uso único, expiração e binding de alvo/args/artifact/revision.
- Check mínimo: pedido de agente com confirmações textuais e sem approval backend é recusado antes do transporte.
- Limite da conclusão: não foi demonstrado um ataque físico nem auditado todo cliente MCP externo; o achado descreve uma lacuna a fechar na integração interna.
- Não fazer: pedir ao próprio modelo que gere um “token de aprovação” ou usar um hash conhecido como assinatura de autorização.

### AUD-13. Referenciais e Drop não generalizados

**[BUG]**

- Prioridade: P1. Confiança: C2; semântica final de telemetria precisa de revalidação.
- Sintoma: posicionamento live/preview pode divergir; Drop de peça rodada pode não tocar corretamente a mesa.
- Causa: conversões diferentes de coordenadas e cálculo de base por local min-Y/escala, sem geometria avaliada rodada.
- Evidência: `LayerPreview.toScene`, `toolheadWorld`, `centerOnPlateTransform`, `settleOnPlateTransform`.
- Impacto: representação do cabeçote, placement, slicing e colisão podem discordar.
- Fix proposto: contratos de frame/unidades explícitos; transformações nomeadas e inversas testadas; Drop pelo mínimo da geometria mundial avaliada.
- Check mínimo: landmarks/origem/eixos coincidem entre mesh, path e posição de telemetria normalizada; Drop mantém eixos horizontais.
- Regressão obrigatória: rotações, escala negativa/não uniforme, parenting, modifier stack, origem de placa e modo não planar futuro.
- Não fazer: trocar Y/Z globalmente por busca/substituição ou clamp silencioso de coordenadas como validação.

### AUD-14. Testes de presença e DOM click ocultam defeitos

**[BUG]**

- Prioridade: P1. Confiança: C2.
- Sintoma: gate verde enquanto controls estão cobertos ou o fluxo real não existe.
- Causa: testes headless oferecem inputs corretos que os callers não oferecem; E2E usa presença/estado e, num caminho, `el.click()` para contornar interceptação.
- Evidência: `context-menu.test`, `editor-reload.e2e`.
- Impacto: número de testes e ausência de crash dão confiança desproporcional ao produto.
- Fix proposto: E2E por input real, hit-testing, outputs/efeitos e provider selection; manter unit/integration como camadas diferentes.
- Check mínimo: regressão falha antes do fix com o mesmo clique físico que o utilizador faria.
- Não fazer: `force:true`, DOM click ou dispatch sintético para provar acessibilidade de um controle ao rato.

### AUD-15. Consistência de scroll, i18n e roadmap

**[BUG]**

- Prioridade: P1 para rastreabilidade/i18n; P2 para aparência de scrollbar. Confiança: C1/C2.
- Sintoma: scrollbars nativas nos containers medidos, labels hardcoded e estados documentais conflitantes.
- Causa: falta de política global de scroll; builders locais; overview desatualizado e status/checkboxes não sincronizados.
- Evidência: E-P08; `context-menu-items`; S9.12 Planned com AC preenchidas; S9.13 ausente do overview.
- Impacto: experiência visual inconsistente e agentes recebem prioridades/status pouco fiáveis.
- Fix proposto: tokens de scroll, catálogo i18n e reconciliação documental baseada em aceitação real.
- Check mínimo: todas as superfícies roláveis inventariadas e PT/EN verificado; status documental corresponde à evidência.
- Não fazer: preencher Done por contagem de testes ou atualizar apenas o overview ignorando o plano detalhado.

## 6. Arquitetura-alvo e contratos

### 6.1 Autoridades e fronteiras

**[SPEC]**
Contratos-alvo propostos:

- Autoridade de projeto: identidade de objetos/partes, geometria, materiais, transforms, membership de placa, operações, revisão e recuperação.
- Autoridade de seleção: estado de seleção confirmado/remapeado pelo backend quando a topologia muda.
- Autoridade de job: captura imutável de inputs, execução, cancelamento, progress, outputs e freshness.
- Autoridade de dispositivo: identidade, capacidades, leitura, transporte de comando, ACK e estado observado.
- Autoridade de política/aprovação: broker/backend, nunca output textual do modelo.
- UI: estado de apresentação, navegação, câmara e edição provisória; snapshots de domínio não são uma segunda implementação do engine.
- Chat: observador e emissor de intenções autorizadas através do mesmo catálogo de ações.

```text
UI / menus / atalhos / command palette / chat
                  |
         catálogo de operações
                  |
    validação + política + expectedRevision
                  |
       dispatcher de domínio existente
       |          |          |          |
   geometria    projetos   slice/jobs  impressoras
       |          |          |          |
     workers    storage    engine/IR   LAN/cloud
                  |
   resultados estruturados + eventos + snapshots
                  |
       UI, journal e contexto do chat
```

**[NOTE]**
Este desenho é lógico. Não exige mover todos os serviços para um processo, introduzir microservices, criar uma nova framework ou duplicar gateways. Identificar o owner de cada contrato e ligar os transportes atuais de forma estreita.

### 6.2 Provider selection

**[SPEC]**

- Selecionar provider num bootstrap explícito, não por imports aleatórios de `mock` em componentes.
- Cada provider declara disponibilidade, versão de contrato, capabilities e origem de dados.
- Demo deve ser visível; a indisponibilidade real não deve causar fallback silencioso para Demo.
- Uma lane suportada em cloud não implica que a mesma lane esteja suportada em LAN ou no provider de perfil declarado.
- Providers devem devolver indisponibilidade estruturada para operações não implementadas.
- A existência de um handle, um trait ou um preset não prova ligação a worker/equipamento.
- Caminhos de leitura e escrita podem reutilizar contratos, mas precisam de disponibilidade e autorização separadas.

| Situação                                   | Comportamento esperado                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Backend de geometria ausente               | Cena existente visível se disponível; edição correspondente desativada com motivo |
| Modo Demo selecionado                      | Fixtures permitidas, banner/estado explícito, nenhuma promessa física             |
| Impressora real offline                    | Último snapshot marcado stale/offline; writes bloqueados segundo política         |
| Backend de slice incompatível com modifier | Preflight com motivo; não ignorar modifier                                        |
| Provider de AI não configurado             | Chat informa estado; não finge resposta de modelo real                            |
| Transport morre após confirmação           | Job indeterminado/falhou; reconciliar antes de repetir efeito                     |

### 6.3 Identidade e revisão

**[SPEC]**

- Introduzir identidade estável distinta do nome editável, com migração de projetos existentes.
- Nome duplicado/alterado não pode redirecionar uma tool para outro objeto.
- Cada alteração autoritativa usa `expectedRevision` quando pode conflitar com outra.
- Revisão cresce por commit de domínio, não por render ou refetch.
- Uma operação provisória não torna artefactos novos válidos.
- Selection/remap após alteração topológica deve referir a revisão correspondente.
- Journal deve incluir add/remove/boolean/repair/material/part/modifier, não só transform.
- Operações sem inversa segura usam snapshots/checkpoints; não inventar um undo matemático.
- Retry de uma operação mutante requer idempotency key ou reconciliação explícita.

### 6.4 Envelope comum de operação

**[SPEC]**
Esquema conceitual proposto, não API já implementada:

| Campo              | Função                                                                                |
| ------------------ | ------------------------------------------------------------------------------------- |
| `operationId`      | Correlação de pedido, resultado, progress e journal                                   |
| `actionId`         | Identificador estável do catálogo                                                     |
| `actor`            | Principal autenticado pelo boundary; não confiar num campo “user” enviado pelo modelo |
| `projectId`        | Isolamento de projeto                                                                 |
| `expectedRevision` | Controle de concorrência de domínio                                                   |
| `target`           | IDs estáveis de objeto/parte/placa/job/dispositivo                                    |
| `args`             | Payload validado pelo schema da ação                                                  |
| `approvalId`       | Referência opaca backend quando requerida                                             |
| `idempotencyKey`   | Deduplicação/reconciliação para operações apropriadas                                 |

| Campo de resultado | Função                                                                          |
| ------------------ | ------------------------------------------------------------------------------- |
| `status`           | `completed`, `pending`, `rejected`, `failed` ou `indeterminate`, segundo a ação |
| `actualRevision`   | Revisão autoritativa após resultado ou conflito                                 |
| `diagnostics`      | Códigos estáveis, explicação e alvos afetados                                   |
| `changedTargets`   | Invalidação seletiva                                                            |
| `selectionRemap`   | Rebase de seleção topológica                                                    |
| `artifacts`        | Referências opacas a outputs validados                                          |
| `result`           | Dados tipados próprios da ação                                                  |
| `provenance`       | Engine/provider/inputs/revisão e origem do resultado                            |

### 6.5 Catálogo partilhado

**[SPEC]**

- Reutilizar a policy existente e ampliar metadados apenas onde necessário.
- Manter schemas/decisões puras partilháveis sem imports de React, R3F ou stores de UI no servidor.
- Separar declaração de ação de handler; schemas não executam efeitos.
- Menu, toolbar, shortcut e tool de chat referem `actionId`, não copies de closures de negócio.
- Disponibilidade deve ser recalculada no backend no momento da execução, não só quando o menu abriu.
- A apresentação de um menu pode conter submenus, separators e toggles; a política não depende desse layout.
- Campo `separatorBefore` deve ser apresentado ou convertido para uma estrutura coerente; não deixar metadata inerte.
- Todo erro de domínio deve ter resultado observável, não apenas `console.warn` ou toast de sucesso genérico.

### 6.6 Frame e unidades

**[SPEC]**

- Nomear frames: local de objeto, world do editor, placa, coordenadas de máquina, IR e tela.
- Declarar unidades nos boundaries: geometria em mm; temperatura em graus Celsius; fluxo em volume por segundo; tempo em unidade definida.
- Fixar conversões de frame em helpers únicos, com testes de roundtrip e landmarks.
- Separar transformação de geometria de transformação de câmara.
- Não aplicar duas vezes placement ao serializar para slice ou ao desenhar Preview.
- Não recentrar cada peça na UI e perder o placement do artefacto.
- Coordenadas fora do volume devem gerar diagnóstico; clipping visual não substitui validação.

## 7. Arquitetura de páginas

### 7.1 Shell e navegação

**[SPEC]**

- Quatro destinos primários: Home, Prepare, Preview e Workbench.
- Estado de projeto deve viver acima da troca de página; não reconstruir a cena por navegação.
- Guardar câmara, seleção, layout e filtros por contexto quando adequado.
- Navegação não cancela um job silenciosamente; oferecer decisão explícita ou continuidade em background.
- Preview pode abrir sem artefacto e mostrar estado vazio com ação Slice.
- Header mostra contexto resumido e saúde do provider; detalhes específicos ficam nas páginas.
- Chat acessível em todas as páginas, sem perda da conversa ativa.
- Keyboard shortcuts têm escopo de página/modo e não capturam digitação de campos.
- O simples store de navegação pode bastar; não introduzir router complexo sem necessidade de deep links/histórico/restore.

### 7.2 Home

| Área                | Conteúdo                                                | Fonte/estado exigido                     |
| ------------------- | ------------------------------------------------------- | ---------------------------------------- |
| Projetos recentes   | Nome, alteração, thumbnail quando existente, reopen     | Project store local; origem explícita    |
| Recuperação         | Autosave/crash recovery, revisão recuperável            | Journal/checkpoint validado              |
| Jobs recentes       | Slice, export, upload, estado e diagnostics             | Job store; artefactos presentes/ausentes |
| Impressões recentes | Dispositivo, resultado reportado, arquivo/job associado | Histórico local/cloud distinguido        |
| Equipamentos        | Online/offline, job ativo, última leitura               | Snapshot com freshness                   |
| Saúde               | Geometria, slice, AI, gateway de dispositivos           | Disponibilidade real, não lista estática |

**[SPEC]**

- Ações: Novo, Abrir, Continuar, Recuperar e consultar histórico.
- Sem login obrigatório para uso local.
- Não tratar cloud files, projetos e print history como a mesma entidade.
- Paginador/filtros para históricos extensos; não bloquear shell enquanto dados cloud chegam.
- Um item histórico aponta para artefacto ou regista ausência; não inventa disponibilidade.
- Reprint é um novo job com validação atual de equipamento, material, arquivo e approval.
- IDs de tarefa/ficheiro de um pedido passado não devem ser reutilizados sem validar o contrato específico.

### 7.3 Prepare

**[SPEC]**

- Autoria de geometria e configuração de fabricação.
- Árvore de objetos, partes, volumes negativos, regiões e modifiers.
- Inspector contextual com propriedades e origem/herança.
- Object/Edit Mode e transform reference local/world.
- Apresentação Mesh/Slicer; Live não pertence a este seletor.
- Materiais de projeto e binding físico separados.
- Mesh diagnostics, repair real, placement e tools de criação.
- Configuração de processo/preset e overrides, com suporte real declarado pelo engine.
- Preview antigo pode existir, mas torna-se stale após mudanças relevantes.

### 7.4 Preview

**[SPEC]**

- Atua sobre um artefacto fatiado e a revisão que o gerou.
- Mostra status: vazio, preparando, em execução, pronto, stale, falhou ou cancelado.
- Slice/Reslice disponíveis conforme preflight; não requer import manual como fluxo normal.
- Configurações que alteram output provocam novo job e indicam invalidação.
- Exploração de paths, filtros, legendas, camadas, segmentos, playback e G-code associado.
- Export e Send só usam artefacto validado/fresh e compatível.
- Edição de mesh retorna a Prepare; não modificar mesh dentro de um Preview sem explicitar a transição.

### 7.5 Workbench

**[SPEC]**

- Lista de equipamentos e detalhe do selecionado.
- Monitor, Filamentos/ACE, Ficheiros, Histórico e diagnóstico avançado, conforme capabilities.
- Status de ligação LAN/cloud separado de presença de preset de máquina.
- Controles de temperatura/fans/luzes/speed, ações de filamento e job, com gating backend.
- Secagem ACE e auto-feed quando suportados; terminologia “ACE”, não inferir equipamento por nome livre.
- Câmara on-demand e indicação de permissões/efeitos quando relevantes.
- Detalhe de job em curso com freshness e origem dos dados.
- Resumo Device em outras páginas pode navegar/focar Workbench; não duplicar a lógica de execução.

### 7.6 Live: três conceitos diferentes

| Conceito                | Pode mostrar                                             | Não deve afirmar                                   |
| ----------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| Câmara                  | Vídeo/imagem do equipamento                              | Posição 3D exata inferida apenas da imagem         |
| Telemetria              | Estado, temperaturas, progress, posição se fornecida     | Artefacto completo quando só há percentagem/camada |
| Representação 3D do job | Paths conhecidos associados ao job e posição normalizada | Correspondência exata para um job desconhecido     |

**[SPEC]**

- Mover o destino Live para Workbench.
- Se o job não tem artefacto conhecido, mostrar monitor/câmara e explicar a ausência de representação de percursos.
- Não transformar `% concluído` num segmento exato sem dados de sincronização.
- Diferenciar toolhead planeado em Preview de toolhead observado em Workbench.

## 8. Menu contextual: contrato e matriz de ações

### 8.1 Contexto resolvido

**[SPEC]**
Um menu deve ser construído a partir de um snapshot de contexto, não de um selector global ambíguo.

| Campo             | Exemplo conceitual                            | Regra                                                 |
| ----------------- | --------------------------------------------- | ----------------------------------------------------- |
| `surface`         | canvas, tree, plateTabs, timeline             | Indica origem para apresentação, não muda autorização |
| `page`            | prepare ou preview                            | Limita ações pertinentes                              |
| `editMode`        | object, vertex, edge, face                    | Determina gramática de seleção/operação               |
| `targetKind`      | object, part, region, plate, background, path | Resultado do picking/contexto DOM                     |
| `targetId`        | ID estável do alvo                            | Nome é apenas label                                   |
| `selectionIds`    | Seleção ativa normalizada                     | Preservar multi-select quando apropriado              |
| `projectRevision` | Revisão do snapshot                           | Revalidar na execução                                 |
| `plateId`         | Placa atingida/ativa                          | Não assumir primeira placa                            |
| `anchor`          | clientX/clientY ou rect de foco               | CSS pixels, frame de tela declarado                   |
| `capabilities`    | Ações suportadas                              | Disponibilidade real do backend                       |

### 8.2 Picking e seleção

**[SPEC]**

- Clique direito em objeto não selecionado seleciona esse alvo e abre ações desse alvo.
- Clique direito num membro de uma seleção múltipla mantém o conjunto, salvo regra de produto explicitamente diferente.
- Alt/modifier para seleccionar parte deve ser definido e partilhado com shortcuts/tool help.
- Em Edit Mode, picking resolve elemento, objeto owner e revisão de topologia.
- Background não herda silenciosamente a seleção antiga como alvo de Delete.
- Mesh lock, visibilidade e printable state são flags diferentes.
- Event propagation deve distinguir R3F, DOM e nativeEvent; confirmar o comportamento real antes de mudar handlers.
- Arrasto direito para pan acima do limiar de movimento não abre menu ao terminar.
- Abrir menu não deve iniciar transform, mover câmara ou enviar comando físico.

### 8.3 Âncora e collision handling

**[SPEC]**

- Guardar o ponto original do pedido.
- Menu no body usa client coordinates; menu canvas-local precisa de conversão explícita para o host.
- Medir menu após montagem antes de ajustar posição final.
- Em região com espaço, canto inicial do menu fica junto do ponto do clique.
- Perto da borda, deslocar/inverter abertura para manter conteúdo acessível; não mover para um canto fixo.
- Atualizar após resize/zoom/layout change ou fechar com motivo coerente.
- Limitar altura à área disponível e permitir scroll quando há muitos itens.
- Submenus evitam sair da janela e têm teclado/foco coerentes.
- `Shift+F10`/Menu key abre junto do elemento ou seleção focada.
- Fechar devolve foco ao owner válido; alvo removido exige fallback de foco seguro.
- Recomenda-se usar a primitive Radix Context Menu para apresentação/submenus; preservar/adaptar o store e registry necessários ao picking 3D.

### 8.4 Matriz de contexto

| Contexto                 | Ações principais                                                                                                            | Condições                             |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Fundo de Prepare         | Importar, criar primitiva, colar, selecionar tudo, organizar placa                                                          | Projeto ativo e providers disponíveis |
| Placa                    | Ativar, renomear, duplicar, mover objetos, configurar, info, fit                                                            | Placa/engine suportados               |
| Objeto único             | Transformar, properties, filament, drop, orientar face, repair, clone, instance, split, add part, negative/modifier, delete | Lock, mesh state e capabilities       |
| Parte                    | Transform local, material/overrides, tipo, separar, remover parte                                                           | Parent e regra de fabricação          |
| Volume negativo          | Editar shape/placement, ativar/desativar, converter tipo, remover                                                           | Não é material imprimível por defeito |
| Modificador de impressão | Editar região, parâmetros e precedência                                                                                     | Parâmetros suportados pelo engine     |
| Multi-select             | Alinhar, distribuir, agrupar, combinar, boolean, mover de placa, atribuir material                                          | Compatibilidade e alvo explicitados   |
| Vértice                  | Mover, extrude, merge, dissolve/delete, smooth                                                                              | Edit Mode + topologia/revisão válida  |
| Aresta                   | Bevel, subdivide, bridge, seam, dissolve/delete                                                                             | Operação compatível com seleção       |
| Face                     | Extrude, inset, triangulate, normals, material, subdivide                                                                   | Operação compatível com seleção       |
| Path de Preview          | Info de segmento/camada, isolar, enquadrar, mostrar G-code                                                                  | Artefacto conhecido e IDs associados  |
| Timeline                 | Seek/replay/reset, informação de operação                                                                                   | Journal e checkpoint válidos          |
| Workbench                | Info/refresh e ações autorizadas do dispositivo                                                                             | Nunca menu CAD sobre equipamento      |

### 8.5 Apresentação e nomenclatura

**[SPEC]**

- Agrupar edição, fabricação, organização e operações destrutivas.
- Submenus para filamentos, add part/negative/modifier, tipo e features extensas.
- Labels i18n, shortcut hints partilhados e disabled reason real.
- Não mostrar headers estáticos como ações executáveis.
- Delete separado e marcado como destrutivo; comportamento segue undo/policy, não aparência apenas.
- Clone independente e linked instance devem ter nomes distintos.
- Place/Drop/Centre/Orient face são operações distintas.
- Uma ação não implementada aparece indisponível com motivo ou fica ausente conforme regra de discovery; nunca simula sucesso.

## 9. Layout: toolbar, placa e overlays

### 9.1 Propriedade de cada zona

| Zona                      | Responsabilidade                                                                  | Evitar                                               |
| ------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Header                    | Navegação, contexto global, operações primárias de página, notifications/settings | Informação técnica permanente de placa e dispositivo |
| Topo do Prepare           | Toolbar de autoria contextual                                                     | Rail de placa concorrente na mesma faixa             |
| Acima dos tabs inferiores | Ações exclusivas da placa + `(i)`                                                 | Misturar playback de Preview sem layout próprio      |
| Tabs inferiores           | Selecionar/criar/renomear placas                                                  | Details de volume sempre expostos                    |
| Canto inferior esquerdo   | Dock pills/readouts com slot explícito                                            | Overlays independentes que se cobrem                 |
| Canto inferior direito    | View cube, quando pertinente                                                      | Duplicar toda a barra de câmera                      |
| Preview                   | Layer/segment controls + legenda                                                  | Controles de autoria escondidos debaixo de sliders   |
| Workbench                 | Device data/control em layout próprio                                             | Modal pequena como única interface de operação       |

### 9.2 Toolbar de autoria

**[SPEC]**

- Seleção, Move, Rotate, Scale, Measure e snap no contexto correto.
- Escolhas Mesh/Slicer separadas da edição Object/Edit Mode.
- Tools avançadas seguem seleção/modo, não uma lista de botões permanente.
- Usar overflow menu e grupos compactos em largura reduzida.
- Remover upgrades e settings de placa permanentes desta barra.
- Um único owner de cada ação; outro entry point pode existir como shortcut/context menu sem repetir a UI sempre visível.
- Estado pressed/disabled/loading deriva da ação e seleção.
- Ícones, labels/tooltips e foco seguem o design system existente.

### 9.3 Barra de placa inferior

**[SPEC]**

- Compor barra e tabs num único owner de layout.
- Ações Fit plate, orientação da placa, Grid, Arrange active plate e `(i)`.
- Fit selection continua possível em contexto de objeto; não alias silencioso de Fit plate.
- Info da placa: profile, surface, build volume, limites, ocupação, origem/freshness e incompatibilidades conhecidas.
- Dados desconhecidos são `unknown`/indisponíveis, não valores do perfil demo.
- Uma placa não herda constraints de outra sem decisão explícita.
- Arrange active plate só opera nos targets da placa ativa; confirmar que o backend recebe esse escopo.
- Sidebar/width changes não deslocam toolbar para fora do frame.

### 9.4 Popup de informação

**[SPEC]**

- Botão `(i)` ou ícone equivalente acessível, com label i18n.
- Popup pequeno, ancorado no botão e com collision handling.
- Abre por click/teclado, fecha por outside/Escape e restaura foco.
- Campo de origem diferencia configuração declarada, dado da máquina e estimativa.
- Não renderizar toda a árvore de configuração no popup; oferecer abrir settings completos.

### 9.5 Responsividade e z-ladder

**[SPEC]**

- Validar no canvas disponível, não apenas em window width.
- Corrigir `min-width`, flex shrink e grid tracks do shell quando o frame ultrapassa a janela.
- Reservar slots de layout antes de recorrer a coordenadas absolute.
- Respeitar o isolamento existente do viewport para painéis canvas-local.
- Menus de aplicação que precisam escapar de clipping devem usar portal/stacking boundary apropriado.
- Z-index define ordem de pintura; não torna duas áreas sobrepostas simultaneamente clicáveis.
- Testar sidebar em tamanhos mínimos/máximos, idioma expandido, zoom e janelas redimensionadas.
- Evitar CSS dependente do número atual de botões ou da largura de um label inglês.

## 10. Apresentação e materiais

### 10.1 Contrato de modos

| Aspeto                  | Mesh                                   | Slicer                                             |
| ----------------------- | -------------------------------------- | -------------------------------------------------- |
| Objetivo                | Inspeção/edição topológica             | Aparência de material e preparação para fabricação |
| Faces                   | Visíveis conforme opção de diagnóstico | Sólido opaco por defeito                           |
| Arestas                 | Disponíveis/claras para edição         | Off por defeito; overlay de diagnóstico opcional   |
| Seleção                 | Elementos/contorno sem ambiguidade     | Contorno sem substituir cor do filamento           |
| Erro de mesh            | Badges/diagnóstico/overlay             | Badges/diagnóstico, preservando material           |
| Revisão de geometria    | Não muda por trocar apresentação       | Não muda por trocar apresentação                   |
| Significado de “sólido” | Não é prova de manifold                | Não é prova de manifold ou de slice                |

### 10.2 Modelo de material de projeto

**[SPEC]**

- Material de projeto tem ID estável, label, tipo de polímero, cor, aparência e preset/process data necessário.
- Cor da peça não deve depender da última telemetria de um equipamento aleatório.
- Binding físico é uma relação separada e versionada.
- Assignment pode ser por objeto, parte e face/região quando suportado.
- Herança/unassigned devem ser explícitos na UI e tools.
- Mudar de impressora preserva a intenção material do projeto e revalida o binding.
- Um modelo multicolor exige correspondência entre assignment geométrico, tool/extruder do slice e slot físico aprovado.

| Entidade               | Dados mínimos propostos                                            |
| ---------------------- | ------------------------------------------------------------------ |
| Material de projeto    | ID, nome, tipo, cor, acabamento, preset e provenance               |
| Assignment             | Target ID, nível de herança, material ID                           |
| Binding físico         | Material ID, printer ID, extruder/tool ID, box/slot, estado/versão |
| Diagnóstico de binding | Não atribuído, incompatível, offline, stale, válido                |

### 10.3 Regra de resolução

**[SPEC]**

1. Resolver o material atribuído ao target pela hierarquia de projeto.
2. Resolver appearance desse material, independentemente do estado loaded.
3. Se existir binding explícito e a policy permitir sincronizar appearance do slot, aplicar só a esse binding e com origem visível.
4. Sem binding, conservar material/preset do projeto e diagnosticar correspondência física desconhecida.
5. Sem material atribuído ou preset resolvido, usar estado unassigned/neutral explícito.
6. Nunca substituir atribuição explícita por “primeiro slot carregado”.

### 10.4 Acabamento e textura

**[SPEC]**

- Separar polímero e acabamento: PLA pode ser matte, silk, wood-filled ou outro acabamento declarado.
- Não escolher classe textured apenas por uma substring que outro if anterior torna inalcançável.
- Mapas de cor usam color space apropriado; bump/roughness são dados, não imagens de cor.
- UVs devem existir quando o shader depende delas; alternativa triplanar/procedural deve operar em frame definido.
- Aparência gerada é representativa; não afirmar equivalência física exata sem calibração.
- Cache de material/texture por chave estável, com cleanup de geometry/material/texture no lifecycle correto.
- Updates de slot não devem recriar todos os materiais por identidade nova de um objeto de matching.
- Renderizar mudanças do estado observado com subscrições seletivas; `getState()` isolado não é uma subscrição.

### 10.5 Aceitação visual e funcional

**[SPEC]**

- Duas peças com materiais distintos mantêm cores distintas após reload/troca de página.
- Duas atribuições da mesma classe de polímero podem mapear a slots de cores diferentes.
- Loaded slot de outro material não altera a escolha explícita.
- Slot removed/offline gera diagnóstico, não troca de cor silenciosa.
- Textura tem variação espacial válida e não muda geometria.
- Pixel/scene checks confirmam sólidos renderizados; inspeção visual deve seguir as regras de tooling/modelo da sessão.
- Preview por filamento e plano de envio usam a mesma assignment/binding aprovada.

## 11. Slicing real e artefactos

### 11.1 Pipeline-alvo

**[SPEC]**

1. Capturar snapshot imutável de projeto, revisão, placas/targets, geometria avaliada e settings.
2. Resolver herança, volumes negativos, modifiers, materiais e binding de ferramentas.
3. Validar mesh/profile/capabilities e constraints relevantes ao engine escolhido.
4. Executar slicing real com progress/cancelamento do backend.
5. Gerar IR preservando atributos, identidade e provenance.
6. Pós-processar para o perfil/kinematics/dialect escolhido.
7. Validar o programa independentemente do gerador e verificar compatibilidade do artefacto de destino.
8. Guardar artefactos content-addressed e metadata do job.
9. Publicar ready apenas com outputs válidos e currentness verificada.
10. Construir Preview do output e navegar para a página correspondente.

### 11.2 Native versus slicer instalado

**[SPEC]**

- Reutilizar planar-core/IR próprios como caminho de produto conforme roadmap atual.
- Manter o adaptador do slicer instalado como provider separado quando autorizado/necessário.
- Identificar engine/version e suporte de features no job e na UI.
- Não degradar silenciosamente modifiers, multimaterial, supports ou nonplanar para um subset diferente.
- Um input aceito no editor pode ser recusado pelo engine com motivo nomeado.
- Não prometer que qualquer G-code produzido é aceite por qualquer firmware; validar packaging/metadata/profile do destino.
- Separar docs legacy de orquestração do slicer das decisões do novo editor próprio; reconciliar documentação quando a integração for aprovada.

### 11.3 Job e artefacto

| Campo proposto    | Regra                                                           |
| ----------------- | --------------------------------------------------------------- |
| `jobId`           | Identidade do job, distinta do ID de tarefa física              |
| `sourceRevision`  | Revisão de input capturada                                      |
| `targetPlateIds`  | Placas/targets efetivamente fatiados                            |
| `inputDigests`    | Geometria avaliada, settings, material/binding e perfil         |
| `engine`          | Nome, versão e capabilities                                     |
| `mode`            | Standard/nonplanar com gates de perfil                          |
| `irArtifact`      | Referência/hash/tamanho/schema do IR                            |
| `programArtifact` | Referência/hash/tamanho/dialect do output final                 |
| `validation`      | Validator version, resultado, warnings/errors e compatibilidade |
| `stats`           | Estatísticas do output, com origem e limites de estimativa      |
| `status`          | Estado autoritativo do job                                      |
| `diagnostics`     | Falhas/preflight/unsupported features por alvo                  |

### 11.4 Cache e freshness

**[SPEC]**

- Cache key inclui geometria avaliada, transforms/placement, settings resolvidos, materiais/tool assignment, perfil, engine/version e mode.
- Alteração relevante invalida currentness mesmo que a quantidade de objetos não mude.
- Reopen só reutiliza artefacto se inputs e validators ainda forem compatíveis.
- Resultado tardio de job antigo não substitui um resultado de inputs atuais.
- Mudança de placa ativa não redireciona o output de um job já capturado.
- Conservar preview antigo com indicação stale é permitido; envio fica bloqueado.
- Missing artifact deve ser mostrado como missing, não automaticamente reconstruído com um engine diferente.

### 11.5 Estado e cancelamento

| Estado           | Transições permitidas conceitualmente | Efeito na UI                 |
| ---------------- | ------------------------------------- | ---------------------------- |
| Idle/vazio       | Preflight                             | Permite configurar/fatiar    |
| Preflight        | Rejected ou Running                   | Mostra verificações reais    |
| Running          | Cancelling, Failed ou Validating      | Progress do backend          |
| Validating       | Failed ou Ready                       | Não enviar antes de validar  |
| Ready            | Stale, Export ou Send proposal        | Preview válido disponível    |
| Stale            | Reslice ou consulta marcada           | Send desativado              |
| Cancelling       | Cancelled ou resultado reconciliado   | Sem sucesso antecipado       |
| Failed/cancelled | Novo job explícito                    | Diagnóstico e retry adequado |

**[SPEC]**

- Não usar delays fixos como progresso de produto.
- Cancelamento deve definir se o processo terminou e se artefactos parciais são utilizáveis.
- Não anunciar ready com stats inventadas para depois chamar fail.
- Estatística estimada sem slice deve ter label de estimativa e nunca habilitar Print.

### 11.6 Aprovação de impressão

**[SPEC]**

- Aprovação vincula printer ID, artefacto/hash, perfil, material/tool binding, parâmetros físicos relevantes e validade.
- Trocar um desses inputs exige nova aprovação.
- Backend revalida disponibilidade e compatibilidade no envio.
- Separar upload de ficheiro, queue de job e início físico; não assumir que são uma única operação.
- ACK da API não é confirmação de impressão iniciada nem de parse bem-sucedido pelo equipamento.
- Reconciliar por status/diagnóstico do dispositivo antes de anunciar o efeito final.

## 12. Preview técnico e step-by-step

### 12.1 Dados preservados

| Dado                   | Fonte requerida                  | Uso no Preview                                     |
| ---------------------- | -------------------------------- | -------------------------------------------------- |
| Segment ID/ordem       | Engine/IR/program mapping        | Slider de segmento e G-code associado              |
| Object/part ID         | Provenance do slice              | Isolar peça e inspeção                             |
| Layer ID/height        | Engine/IR                        | Faixa/camada, Z e diagnóstico                      |
| Path kind              | Engine/IR                        | Wall, infill, support, travel, brim/skirt e outros |
| Tool/extruder/material | Plano de ferramentas             | Cores por filamento e troca de tool                |
| Speed comandada        | IR/programa                      | Legenda em unidade definida                        |
| Flow volumétrico       | IR/programa ou cálculo declarado | Legenda e limites de material                      |
| E/volume/bead          | IR                               | Inspeção de deposição                              |
| Width/height           | Engine/IR                        | Análise de line width/layer height                 |
| Cooling/temperature    | Dados realmente emitidos         | Filtros/inspeção quando presentes                  |
| Tempo/acceleration     | Engine/modelo temporal declarado | Playback estimado, com limites indicados           |
| Program offsets        | Pós-processador/parser           | Selecionar instrução relacionada                   |

**[SPEC]**

- A evolução do parser deve preservar atributos suportados em vez de os apagar silenciosamente.
- Validar versões, limites de tamanho/segmentos, números finitos e referências cruzadas.
- Metadados não disponíveis são nullable/unsupported, não zero inventado.
- `BRIM`/`SKIRT` e novos kinds não devem cair indiscriminadamente no bucket visual de travel.
- Camada nominal e altura instantânea de um path não planar são conceitos diferentes.
- Índice de slider não deve assumir que layer IDs começam sempre em zero e são contíguos.

### 12.2 Filtros e legendas

**[SPEC]**

- Cor por função, filamento/tool, speed, flow, layer height, line width e atributos adicionais realmente disponíveis.
- Filtros para walls internas/externas quando distintas, infill, solid fill, support/interface, travel, retrações, seams, prime/purge e tool changes.
- Legenda mostra unidade, intervalo e distribuição de valores relevantes.
- Toggle não deve reexecutar slice.
- Guardar opções por contexto/job quando apropriado.
- Não representar velocidade comandada como velocidade física medida.
- Dados calculados devem ter formula/origem explicitada; dados ausentes tornam a visualização indisponível.

### 12.3 Reprodução

**[SPEC]**

- Slider vertical escolhe camada/faixa.
- Slider horizontal escolhe passo/segmento dentro da faixa.
- Play/Pause, passo anterior/seguinte, velocidade de reprodução e jump to layer/segment.
- Modos camada única e acumulação de camadas anteriores.
- Cabeçote planeado acompanha a sequência conhecida do output.
- Highlight de segmento e instrução associada.
- Scrub estável; não reprocessar o documento inteiro a cada pointermove.
- Playback usa ordem de execução e travels explícitos/normalizados; não a ordem visual arbitrária de buckets de cor.
- Não simular aceleração, vazão física ou progress live com precisão inexistente.

### 12.4 Render e desempenho

**[SPEC]**

- Usar typed arrays e render em lotes por atributo/grupo apropriado.
- Evitar um React component/draw call por segmento.
- Preparar dados em worker/chunks para não bloquear navegação e chat.
- Cancelar preparação antiga ao trocar de artefacto.
- Libertar buffers/geometries/materials de jobs removidos.
- Estabelecer budgets com corpus representativo antes de otimizar; medir latência de load/scrub e uso de memória.
- Escolher representação de bead/linhas segundo modo e orçamento de GPU, sem prometer simulação física completa.
- O limite atual de parser é um guard, não uma garantia de desempenho aceitável.

## 13. CAD completo e operações de mesh

### 13.1 Diferenciar capacidades

| Capacidade         | Natureza                    | Exemplo                        | Requisito de autoridade                |
| ------------------ | --------------------------- | ------------------------------ | -------------------------------------- |
| Object editing     | Placement/organização       | Move, rotate, scale, clone     | Cena/transação                         |
| Mesh editing       | Topologia/elementos         | Extrude, inset, bevel, merge   | Worker de mesh + remap                 |
| Geometric modifier | Avaliação não destrutiva    | Mirror, Array, Solidify        | Stack ordenado + mesh avaliada         |
| Print modifier     | Parametrização regional     | Infill/walls/speed numa região | Settings resolver + slicer             |
| Negative volume    | Subtração de fabricação     | Cavidade/recorte local         | Modelo de volumes + slicing/evaluation |
| Support control    | Regra/região de suporte     | Blocker/enforcer/painting      | Features suportadas pelo engine        |
| Appearance         | Apresentação                | Cor/textura/material           | Material assignment, sem alterar mesh  |
| Sculpt/remesh      | Edição densa/reestruturação | Brush/voxel remesh             | Worker dedicado e budgets              |

### 13.2 Object Mode e transformações

**[SPEC]**

- Selection, multi-selection, hide/show, lock e printable flags.
- Transform numeric/gizmo em local/world com pivot/origin explícitos.
- Apply/reset transform quando suportado; não confundir alteração de matriz com bake de geometria.
- Clone independente e instância partilhada têm semânticas e IDs diferentes.
- Rename nunca altera a identidade usada por tools/journal.
- Parent/child preserves local/world placement com opção explícita.
- Align/distribute/arrange recebem target set e frame definido.
- Drop só altera componente vertical necessária; Centre e Orient face são comandos separados.

### 13.3 Edit Mode e seleção topológica

**[SPEC]**

- Vertex/edge/face modes com picking, box selection e operações compatíveis.
- Selection IDs ligados à revisão da mesh, não índices locais reciclados sem remap.
- Seleção de superfície avaliada/modificada precisa de regra de correspondência para a mesh base.
- Alteração topológica devolve remap/removed elements.
- Cancel de edição provisória restaura geometria e seleção anteriores.
- Commit valida invariantes e regista resultado no journal.
- Não usar triangle index do renderer como identidade permanente de face do backend.

### 13.4 Matriz inicial de paridade de edição

| Grupo        | Operações requeridas no programa de paridade                      | Teste de resultado                                         |
| ------------ | ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Transform    | Move/rotate/scale de elementos, local/world, proportional editing | Coordenadas e invariantes de seleção                       |
| Construção   | Extrude vertices/edges/faces, inset, fill/bridge                  | Topologia, posição e winding                               |
| Refinamento  | Bevel, subdivide, loop cut quando suportado                       | Connectivity, dimensões e normais                          |
| Limpeza      | Merge by distance, dissolve, delete, degenerate cleanup           | Contagens + diagnóstico independente                       |
| Separação    | Split, separate selection/loose parts                             | IDs, placement e membership                                |
| Corte        | Bisect/knife/cut, caps quando requeridos                          | Superfície e fechamento validado                           |
| Normais      | Recalculate/flip e shading                                        | Orientação e integridade de faces                          |
| Material     | Assignment por face/parte                                         | Correspondência antes/depois de remap                      |
| Modifiers    | Mirror, Array, Boolean, Solidify, Bevel, Subdivision, Decimate    | Stack order, evaluated geometry e undo                     |
| Edição densa | Remesh/sculpt/UV/painting                                         | Budget, persistência e preservação de regiões não editadas |

**[NOTE]**
A lista descreve o objetivo de produto, não uma promessa de implementação imediata de todo o Blender. Cada capability deve entrar com schema, backend real, UI/tool binding, limites e corpus de paridade.

### 13.5 Stack não destrutivo

**[SPEC]**

- Ordem do stack importa e é persistida.
- Enable/disable, reorder, duplicate, remove e apply precisam de operações distintas.
- “Apply” altera a mesh base e é uma transação com undo/checkpoint.
- Identificar geometria base e avaliada, respetivos hashes e revisions.
- Slice consome a versão avaliada escolhida; Preview refere o hash usado, não a mesh base atual.
- Modificador geometric não é o mesmo que print modifier; labels/menus devem manter a distinção.
- Instâncias partilhadas exigem confirmação/semântica quando a edição da mesh afeta múltiplos targets.

### 13.6 Partes e volumes de fabricação

**[SPEC]**

- Object pode conter partes com material/settings próprios e transform local.
- Modelo de volume declara role: printable part, negative, print modifier, support blocker/enforcer, conforme capabilities.
- Uma mudança de role tem consequências visíveis e invalida o slice.
- Negative volume não recebe um plano de filamento imprimível por defeito.
- Volumes sobrepostos têm precedência definida e diagnósticos quando ambíguos.
- Regional modifiers recebem whitelist de parâmetros suportados; não fingir que qualquer setting global pode variar espacialmente.
- Split/separate preserva provenance e atribuições válidas; referências removidas geram diagnóstico.

### 13.7 Repair real

**[SPEC]**

- Detectar e reportar tipos de defeito: boundaries abertas, non-manifold, duplicados/degenerados, normais e self-intersections quando o validador suportar.
- Declarar quais defeitos o algoritmo consegue corrigir e quais recusa.
- Oferecer replace/copy preservando placement/material/plate e fontes quando apropriado.
- Executar backend real e devolver output digest, diagnostics before/after e métricas.
- Não fechar aberturas deliberadas sem regra/consentimento quando altera intenção de design.
- “Watertight” vem de validação geométrica, não de estimativa de número de vértices.
- Repair que não resolve o defeito retorna resultado parcial/falha, sem habilitar Print indevidamente.

### 13.8 Uso de Blender e kernels existentes

**[SPEC]**

- Descobrir/pinar worker segundo contratos existentes, nunca path de máquina hardcoded.
- Não conceder ao modelo handle Blender arbitrário ou execução raw de scripts pela integração normal.
- Operações tipadas são implementadas por adapters trusted e workers com limites/watchdog.
- O corpus existente é evidência de operações isoladas; não constitui o adapter de produto por si só.
- Bibliotecas preservadas podem ser reutilizadas segundo policy/licenças, sem criar segunda cena autoritativa.
- Não ampliar o uso de dependências legacy exceptuadas sem resolver a restrição documentada.

## 14. Workbench e transportes físicos

### 14.1 Estado de dispositivo

**[SPEC]**

- Identidade real do dispositivo distinta do perfil declarado de slicing.
- Capabilities normalizadas e desconhecidos nullable.
- Snapshot contém capturedAt/freshness/source; stale é estado visível.
- Cambiar selection de printer invalida dados/approvals que pertencem ao anterior.
- Polling lifecycle não deve depender exclusivamente de uma modal estar montada.
- Atualização em background adapta frequência sem comprometer alertas de job ativo.
- Manter isolados snapshots de vários dispositivos; não reutilizar um como fonte universal de materiais.

### 14.2 Controles requeridos

| Área        | Operações                                                 | Guards                                                         |
| ----------- | --------------------------------------------------------- | -------------------------------------------------------------- |
| Temperatura | Consultar/set target por probe suportada                  | Perfil/capability, limites, freshness e approval conforme ator |
| Ventoinhas  | Consultar/set velocidade                                  | Identidade do fan, limites e suporte                           |
| Luzes       | Toggle/brightness                                         | Capability e efeitos secundários                               |
| Velocidade  | Mode/factor permitido                                     | Semântica de protocolo, job state e suporte                    |
| ACE         | Estado, humidity/temp, slots, remaining, drying           | Dados conhecidos, box/slot corretos                            |
| Secagem     | Start/stop/configuração                                   | Temperatura/duração válidas e comando real aprovado            |
| Filamento   | Binding/manual info, auto-feed e alimentação se suportada | Não forjar RFID; movimentos requerem guards próprios           |
| Job         | Pause/resume/stop/start                                   | Estado atual, artefacto/printer vinculados e policy            |
| Ficheiros   | List/preview/upload/send/delete quando autorizados        | Paths/IDs validados, storage preflight e efeitos separados     |
| Câmara      | Start/stop quando disponível                              | On-demand, permissões e origem do stream                       |

### 14.3 Estados de comando

**[SPEC]**

- `proposed`: intenção preparada, nada enviado.
- `approved`: consentimento válido backend, ainda sem efeito.
- `submitted`: transmitido ao transporte.
- `accepted`: transporte/equipamento aceitou a ordem no nível documentado.
- `observed`: leitura subsequente confirmou o efeito relevante.
- `refused`, `failed`, `timeout` e `indeterminate` são distintos.
- UI e chat não devem chamar accepted de observed sem evidence.
- Timeout de uma ação física não autoriza repetir automaticamente a ordem.

### 14.4 Testes físicos

**[SPEC]**

- Primeiro validar envelope, policy e mapping com transport controlado.
- Executar smoke de leitura real quando autorizado e sem segredos nos outputs.
- Teste físico exige pedido específico e preflight do alvo/ambiente.
- Registar somente evidência redigida nos locais permitidos pelo repositório.
- Nunca utilizar “full health gate” como autorização implícita para heat/motion/feed/dry/start.
- Separar readiness de filamento de uma prova de disponibilidade para cada tool/material do job.
- Compatibilidade de firmware é verificada para o artefacto; não definida por defaults de uma máquina observada.

## 15. Chat interno e paridade total de tools

### 15.1 Significado de controle completo

**[SPEC]**

- Cobertura funcional das operações públicas, não acesso irrestrito ao host.
- Agente pode descobrir, inspecionar, propor e executar todas as operações autorizadas do seu contexto.
- Operações proibidas por política continuam proibidas, mesmo com pedido natural “faça tudo”.
- Ações físicas/destrutivas/custosas obedecem a guards e aprovações adequadas.
- Chat vê resultados estruturados e estado autoritativo da aplicação.
- UI e AI usam o mesmo handler de domínio; não criar uma lane AI “mais poderosa” sem as mesmas invariantes.

### 15.2 Famílias mínimas

Os nomes abaixo são vocabulário-alvo proposto, não tools já registadas.

| Família     | Leitura/discovery                        | Intenções de escrita/apresentação                  |
| ----------- | ---------------------------------------- | -------------------------------------------------- |
| `project`   | List/info/revision/artifacts/recovery    | New/open/save/recover/export                       |
| `scene`     | Objects/hierarchy/transforms/diagnostics | Add/rename/clone/instance/remove/parent/transform  |
| `selection` | Selection/mode/target info               | Select/set mode/remap-aware selection              |
| `mesh`      | Metrics/topology/validation              | Extrude/inset/bevel/merge/split/cut/repair/cleanup |
| `modifier`  | Stack/evaluated state                    | Add/configure/reorder/toggle/apply/remove          |
| `material`  | Catalog/assignment/binding/compatibility | Assign/update/bind/reset inheritance               |
| `plate`     | Plates/profile/occupation/constraints    | Activate/add/duplicate/configure/arrange/drop      |
| `slice`     | Job state/diagnostics/artefacts          | Preflight/start/cancel/reslice                     |
| `preview`   | Layer/segment/attributes/G-code mapping  | Filters/seek/play/pause/fit                        |
| `printer`   | Devices/snapshot/files/job/history       | Typed approved controls/upload/print               |
| `history`   | Project/job/print logs/provenance        | Authorized recovery/reprint proposal               |
| `ui`        | Page/panels/camera/theme/visible context | Navigate/focus panel/camera/show information       |

### 15.3 Catálogo para o modelo

**[SPEC]**

- Cobertura completa não exige enviar todos os schemas extensos em cada prompt.
- Disponibilizar discovery/describe e selecionar tools por contexto/capability/permite.
- Omissão temporária de tool no prompt não pode ser confundida com backend inexistente; discovery deve explicar disponibilidade.
- Descriptions devem distinguir read, presentation, reversible edit, costly generation e physical effect.
- Validar inputs/outputs e versionar schemas.
- Resultado de tool é dado não confiável para conceder permissões; não executar instruções embutidas no output.
- Não passar tokens, paths privados ou todos os buffers da mesh ao modelo por defeito.

### 15.4 Contexto mínimo do chat

| Dado                      | Motivo                           | Política                          |
| ------------------------- | -------------------------------- | --------------------------------- |
| Project/revision          | Referenciar cena correta         | Isolamento e expectedRevision     |
| Página/placa              | Ações apropriadas ao contexto    | Navegação não muda autorização    |
| Seleção/edit mode         | Operações de mesh correctas      | Selection IDs revision-bound      |
| Materiais/binding         | Cor/fabricação consistente       | Resumo e IDs de domínio           |
| Slice/artifact freshness  | Não editar/enviar output errado  | Artifact digest e sourceRevision  |
| Dispositivo/capabilities  | Ações físicas suportadas         | Freshness, policy e segredos fora |
| Últimas ações/resultados  | Conhecer mudanças feitas pela UI | Journal/eventos estruturados      |
| Budget/model availability | Custos/cancelamento honesto      | Limites backend                   |

### 15.5 Execução e transcript

**[SPEC]**

1. Modelo recebe contexto/discovery autorizado.
2. Propõe tool call com argumentos tipados.
3. Backend valida schema, principal, contexto, revisão, budget e capability.
4. Se necessário, cria approval request; nenhuma escrita física ocorre ainda.
5. Utilizador responde pela UI autenticada; backend vincula consentimento.
6. Dispatcher executa no mesmo handler usado pela UI.
7. Progress/result/error são publicados como partes/eventos estruturados.
8. Snapshots/cache/contexto são atualizados de forma seletiva.
9. Agente verifica resultado relevante por leitura quando necessário.
10. Só então comunica o efeito comprovado, distinguindo pending/accepted/observed.

**[SPEC]**

- Renderizar input streaming/available, approval requested/responded, progress, output available, denied e error conforme protocolo realmente utilizado.
- Persistir tool-call IDs, aprovação redigida, resultado e operação associada.
- A interrupção da geração de texto não cancela uma ação física já enviada por si só.
- Reconnect não reexecuta automaticamente tool mutante.
- Contexto de outra conversa/projeto não é carregado por engano.
- Cards de operação devem permitir abrir detalhe/artefacto relacionado, sem depender de o agente descrever tudo em texto.

### 15.6 Aprovação autenticada

**[SPEC]**

- Backend mantém record de approval com principal, action, target, args digest, revision/artifact, expiração e consumo.
- Identificador opaco/referência ou token autenticado é emitido pelo backend, não inventado pelo modelo.
- Principal “user” não pode ser alegado por `actor` de payload não confiável.
- `confirm:true` e palavra literal podem existir como defesa adicional, mas não substituem authority humana.
- Alteração de printer, material, artefacto, parâmetros ou revisão relevante invalida approval.
- Consentimento deve ser explicado em termos de efeitos concretos: aquecer, secar, mover, alimentar, imprimir, cancelar, eliminar ou custo externo.
- Log não contém segredo nem approval bearer reutilizável.
- Revogação é verificada imediatamente antes de qualquer efeito.

### 15.7 Segurança e AI-generated tools

| Risco                                   | Controle requerido                                                          |
| --------------------------------------- | --------------------------------------------------------------------------- |
| Spoofing de consentimento               | Approval backend + principal autenticado                                    |
| Tampering entre review e execute        | Binding de args/target/artifact/revision e revalidação                      |
| Prompt injection por ficheiro/mesh/tool | Dados não elevam permissão; proposals tipadas e policy                      |
| Execução raw de host/Blender            | Named capabilities trusted; sandbox/watchdog conforme arquitetura existente |
| Esgotamento de CPU/GPU/memória          | Budgets por geometry/job, cancelamento e backpressure                       |
| Loop infinito de tools                  | Limites de steps/budget/time e interrupção backend                          |
| Retry com efeito duplicado              | Idempotência quando disponível e reconciliação física                       |
| Vazamento de segredos                   | Keystore/backend, redaction e context whitelist                             |
| Operação sem atribuição                 | Correlation IDs e journal de ator/ação/efeito                               |

**[SPEC]**

- Tools geradas preservam manifest/hash, testes, approval, registration e revocation existentes.
- Não autorizar raw shell/raw Blender como atalho para ampliar cobertura.
- A VM/sandbox de sprint futura não deve ser anunciada como proteção já ativa.
- Não conceder capabilities pela existência de uma memória, mensagem de histórico ou description de tool.

## 16. Scrollbars, acessibilidade, i18n e estados

### 16.1 Scrollbars

**[SPEC]**

- Aplicar tokens de thumb/track/hover consistentes em light/dark.
- Usar CSS nativo `scrollbar-color`/`scrollbar-width` quando suportado.
- Fallback WebKit deve ser condicionado/coerente com suporte nativo; não assumir que ambas as famílias de estilos se compõem sempre.
- Usar o ScrollArea existente de forma seletiva; não reimplementar rolagem inteira com wheel handlers.
- Manter scroll por teclado, wheel, touch e drag do thumb.
- Não ocultar scrollbar como solução para inconsistência visual.
- Reservar gutter onde necessário para evitar jumps de layout.
- Respeitar forced-colors/alto contraste e preferência do sistema.
- Inventariar sidebar, transcript, dock bodies, menus/submenus, popovers, tables, files, history, settings e footer.
- Novos containers devem seguir o mesmo padrão sem copiar CSS local divergente.

### 16.2 Acessibilidade e interação

**[SPEC]**

- Menus com roles e estados corretos; não trocar role de botão por listitem e perder semântica de ação.
- Focus visible, restore focus e ordem de tab previsível.
- Escape fecha primeiro o contexto apropriado sem apagar seleção/projeto indevidamente.
- Popovers/modalidades têm comportamento de foco coerente com o seu papel real.
- Ícones desconhecidos têm labels/tooltips; contagens não são a única explicação de erro.
- Mouse/keyboard/touch targets adequados ao dispositivo; não extrapolar compliance por medida de um único botão.
- Contraste e forced-colors testados nos estados normal/disabled/selected/error.
- UI de densidade desktop pode ser compacta, mas não deve impedir operação por teclado ou em zoom.
- Não anunciar conformidade WCAG completa com base neste documento; requer avaliação específica.

### 16.3 PT/EN

**[SPEC]**

- Labels, disabled reasons, tooltips, cards de approval, mensagens de job e menus vêm do catálogo i18n.
- Unidades/formatos/locales têm regra coerente.
- Mensagens de backend usam códigos estáveis e dados; UI traduz onde apropriado sem apagar a causa.
- Nomes de objetos do utilizador não são traduzidos.
- Doc de sprint que pede PT-PT deve ser reconciliado com o locale efetivamente oferecido pela aplicação; não chamar PT-BR de PT-PT por conveniência.
- Não marcar “zero hardcoded strings” com builders de menu ingleses ainda presentes.
- Testar strings longas, labels técnicas, pluralização e truncation com tooltip/accessible name.

### 16.4 Estados completos

| Estado           | Expectativa                                                        |
| ---------------- | ------------------------------------------------------------------ |
| Empty            | Ação inicial pertinente, sem ficções de dados                      |
| Loading          | Skeleton/progress adequado, contexto preservado                    |
| Disabled         | Motivo específico, backend/capability/revision visível quando útil |
| Pending approval | Efeito ainda não enviado                                           |
| Running          | Progresso/cancelamento e target claramente associado               |
| Success          | Resultado comprovado com nível de evidência                        |
| Partial          | Diagnósticos e limites, sem “concluído” genérico                   |
| Error            | Código/causa recuperável, retry apropriado                         |
| Offline/stale    | Última leitura/origem, sem fingir freshness                        |
| Unknown          | Campo desconhecido, nunca substituído por zero                     |

## 17. Sprints e sequência de integração

### 17.1 Estado documental observado

**[SPEC]**

- [sprint-overview.md](../../sprint-planning/sprint-overview.md) é o índice canónico declarado, mas está desatualizado em partes.
- A baseline documenta Sprints 1 a 9.11 como entregues; isso não demonstra que todas as capacidades estejam ligadas ao produto real.
- [Sprint 9.12](../../sprint-planning/sprint-9-12/sprint.md): 001/002/003 Done; 004 Planned com checkboxes já preenchidas.
- [Sprint 9.13](../../sprint-planning/sprint-9-13/sprint.md): quatro tickets documentados como Done, integração cloud de leitura; ausência de linha correspondente no overview.
- [Sprint 10](../../sprint-planning/sprint-10/sprint.md), [11](../../sprint-planning/sprint-11/sprint.md), [12](../../sprint-planning/sprint-12/sprint.md) e [13](../../sprint-planning/sprint-13/sprint.md) continuam pendentes no roadmap observado.
- O documento antigo [ui-gap-audit-2026-09-30.md](../ui-gap-audit-2026-09-30.md) é histórico; não usar os seus estados antigos como inventário atual.
- O gate enumerado em AGENTS e os counts históricos podem diferir dos scripts atuais. Consultar scripts do package e resultados atuais, não tratar números antigos como golden assertion.

### 17.2 Revalidação de aceitação por entrega existente

| Sprint/área | Reutilizar                              | Revalidar/fechar no produto                                      | Achados                        |
| ----------- | --------------------------------------- | ---------------------------------------------------------------- | ------------------------------ |
| S6          | Shell, project store, profile contracts | Bootstrap de providers e disponibilidade honesta                 | AUD-08, AUD-10                 |
| S7          | IPC, remap, journal e corpus            | Worker real, seleção topológica e integração de edição           | AUD-07, AUD-08, AUD-13         |
| S8          | Planar-core, IR e validator             | Cena atual -> artefacto -> Preview, dados técnicos preservados   | AUD-06, AUD-13                 |
| S9          | Harness/policy/lifecycle                | Provider/tool loop, approval autenticado e resultados            | AUD-09, AUD-12                 |
| S9.4        | Placas, toolbar, view presets           | Scope de actions e layout sem overlap                            | AUD-03                         |
| S9.5        | Job UI e send flow                      | Output real, invalidation e artefacto aprovado                   | AUD-06, AUD-11                 |
| S9.6        | Conversas/persistência/settings         | Chat operacional e materiais de projeto/binding                  | AUD-05, AUD-09, AUD-10         |
| S9.7        | Boolean/snap/repair affordances         | Operação geométrica real e undo/provenance                       | AUD-07, AUD-08                 |
| S9.8        | Context menu, labels, measure/i18n      | Picking/actions/keyboard, click real e completude                | AUD-01, AUD-02, AUD-14, AUD-15 |
| S9.9/S9.10  | Snapshot/policy/controle UI             | Lane real de comandos e efeitos observados                       | AUD-11, AUD-12                 |
| S9.11       | Modos/material/live/plate               | Binding, rendering, frames e destino Workbench                   | AUD-04, AUD-05, AUD-13         |
| S9.12       | Files/DevTools/MCP tools                | Cobertura interna, policy autenticada, i18n e closeout           | AUD-09, AUD-11, AUD-12, AUD-15 |
| S9.13       | Descoberta/diagnóstico cloud            | Preservar leitura; ligar escrita autorizada por boundary próprio | AUD-11                         |

**[SPEC]**

- Reabrir/revalidar critérios concretos não significa apagar commits, reverter toda a sprint ou reconstruir módulos entregues.
- Documentar diferença entre contrato unit-tested e integração de produto.
- Corrigir status só após evidência; checkboxes e headline devem concordar.
- Adicionar referência cruzada para esta auditoria quando uma entrega fecha um achado, sem reescrever a história.

### 17.3 Sequência recomendada, sem criar novas sprints

| Etapa | Domínio                   | Dependência                              | Resultado de saída                                                                    | Esforço indicativo |
| ----- | ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| A     | Estabilidade de interação | Baseline atual                           | Menu com âncora/target, layout de placa, scroll e input real testados                 | M                  |
| B     | Autoridade operacional    | Contratos atuais S6/S7                   | Providers explícitos, revisão/journal persistentes, operações reais e policy boundary | L/XL               |
| C     | Workspace e materiais     | B; partes de A                           | Quatro páginas, Home local, Workbench rehost, binding/material presentation           | L                  |
| D     | Slice/Preview real        | B; contrato de material/volumes de C     | Job/artefacto válido, invalidation, preview técnico e playback                        | XL                 |
| E     | Agente integrado          | Registry inicia em B; integra C/D        | Cobertura completa, transcript estruturado, approvals e verificação                   | XL                 |
| F     | CAD avançado              | B; registry/policy e selection contracts | Paridade progressiva de Edit Mode, stack, partes e edição densa                       | XL contínuo        |

**[NOTE]**
As letras são ordem de integração, não IDs de tickets nem estimativa de calendário. O catálogo e testes de paridade começam cedo; a etapa E fecha a integração, não adia toda a AI até ao fim.

### 17.4 Relação com o roadmap futuro

**[SPEC]**

- S10: auth/memória/multi-project; manter local-first e alinhar isolamento completo com S10-005.
- Home local básica não precisa esperar por auth cloud.
- S11: não planar S2; integrar apenas depois de o baseline planar e os frames serem confiáveis.
- S12: conformal S3; preservar gates físicos/estruturais e não overclaim.
- S13: VM/multi-axis; não usar como proteção já implementada para permitir raw exec agora.
- Antes de transformar etapas deste guia em sprints, consultar o skill de sprint planning, confirmar numeração existente e atualizar documentos canónicos em `sprint-planning/`.
- Não colocar planos formais de sprint dentro de `docs/audit/`.

## 18. Protocolo de execução para agentes

### 18.1 Preparação de uma tarefa

**[SPEC]**

1. Identificar achado/requisito e domínio a fechar.
2. Ler instruções do repositório e políticas relevantes.
3. Confirmar git status e preservar alterações alheias.
4. Revalidar o anchor no código atual; não seguir line numbers antigos cegamente.
5. Definir uma hipótese falsificável local e o check mais barato que a refuta.
6. Confirmar se a ação envolve dados/código apenas ou efeito físico/custo externo.
7. Definir a menor alteração testável, gates de saída e limites do escopo.
8. Só depois editar; não mapear todo o repo quando o owner local já está identificado.

### 18.2 Responsabilidades lógicas

| Responsabilidade | Resultado esperado                                    | Limite                                             |
| ---------------- | ----------------------------------------------------- | -------------------------------------------------- |
| Investigação     | Anchor, causa, contrato e check discriminante         | Não transformar hipótese em fix sem evidência      |
| Implementação    | Alteração pequena no owner correto, contrato coerente | Não ampliar escopo nem contornar gates             |
| Diagnóstico      | Reprodução/test output/causa de falha                 | Não declarar sucesso porque só compilou            |
| Validação UX     | Input real, hit-testing, estados e responsive         | Não forçar clique para esconder overlap            |
| Revisão          | Riscos, regressões, policy e aceitação                | Não aceitar mock como efeito real                  |
| Coordenação      | Dependências, status e evidência de saída             | Não conceder ferramentas/permissões fora da sessão |

**[SPEC]**

- Estes papéis não exigem vários agentes; uma tarefa simples pode ser executada diretamente.
- Se houver delegação autorizada, respeitar tools lists e limites reais de cada agente.
- Uma alteração de contrato partilhado precisa de revisão dos consumers implicados, não de refactor global automático.

### 18.3 Durante a implementação

**[SPEC]**

- Usar patches estreitos; preservar conventions e public APIs salvo necessidade comprovada.
- Após o primeiro edit substantivo, executar imediatamente o check focused disponível.
- Se falhar por defeito local, corrigir o mesmo domínio e repetir o check antes de ampliar investigação.
- Não criar ficheiros de teste adicionais se um suite existente apropriado pode receber a regressão.
- Providers mock/reais devem permanecer distinguíveis por tipo/metadata e pela UI quando relevante.
- Não alterar ficheiros tracked enquanto um gate de validação está em execução.
- Não adicionar dependências para resolver algo já suportado por primitive/utility existente.
- Identificar migration e rollback de mudanças de schema/persistência antes de as publicar.
- Mudanças em geometria/tool/material/jobs devem atualizar o invalidation contract correspondente.

### 18.4 Antes de entregar

**[SPEC]**

- Executar regressão do comportamento afetado e os gates pertinentes.
- Verificar normal, empty, loading, unavailable, stale, failed e cancellation.
- Confirmar a equivalência de UI, shortcut/menu e tool onde a ação é partilhada.
- Rever diff e sanitizer em modo dry-run.
- Não fazer commit/push sem autorização expressa da tarefa.
- Se a tarefa é implementação de sprint autorizada, seguir o procedimento e gates do plano canónico.
- Entrega contém: achados fechados, ficheiros alterados, comandos/checks e resultados, evidência de produto e limitações.
- Não comunicar “real”, “imprimiu”, “reparou”, “seguro” ou “paridade completa” além do que foi comprovado.

### 18.5 Modelo de evidência de saída

```text
Achado/requisito:
Baseline e alterações alheias preservadas:
Owner/anchor atual:
Hipótese local:
Check discriminante e resultado antes:
Alteração mínima:
Provider/backend utilizado:
Resultado depois:
Critérios de aceitação cobertos:
Unit / integration / E2E / hardware:
Gates e exit codes:
Dados/artefactos redigidos:
Riscos/limitações ainda abertos:
Necessidade de atualizar status canónico:
```

## 19. Matriz de testes e definição de pronto

### 19.1 Menu contextual

| ID     | Critério verificável                                               | Nível           |
| ------ | ------------------------------------------------------------------ | --------------- |
| CTX-01 | Caller real conserva ponto de clique central com espaço disponível | E2E/input real  |
| CTX-02 | Quatro cantos/bordas mantêm menu acessível por collision handling  | E2E             |
| CTX-03 | Resize/zoom/scroll não misturam frames ou DPR                      | E2E             |
| CTX-04 | Keyboard anchor, Escape e restore focus funcionam                  | A11y/E2E        |
| CTX-05 | Árvore e canvas oferecem mesma operação de objeto/contexto         | Integration/E2E |
| CTX-06 | Clique direito em seleção múltipla mantém target set correto       | E2E             |
| CTX-07 | Parte/negative/modifier tem ações de seu role                      | Unit + E2E      |
| CTX-08 | Edit Mode resolve vertex/edge/face com revisão válida              | Integration/E2E |
| CTX-09 | Pan direito não abre menu depois de drag                           | Input real      |
| CTX-10 | Arrange/Measure executam ação real ou recusam honestamente         | Integration/E2E |

### 19.2 Layout e navegação

| ID     | Critério verificável                                                    | Nível                  |
| ------ | ----------------------------------------------------------------------- | ---------------------- |
| UI-01  | Toolbar e plate controls não se sobrepõem na largura de 1743 px         | Browser geometry       |
| UI-02  | Mesmo contrato a 1280 px com sidebar aberta                             | Browser geometry/input |
| UI-03  | Shell não excede indevidamente janela de 1024 px                        | Responsive             |
| UI-04  | Resize sidebar/zoom/idioma longo mantém input acessível                 | Responsive/A11y        |
| UI-05  | Fit plate enquadra a placa, não só objeto selecionado                   | E2E/scene              |
| UI-06  | Fit selection enquadra seleção e tem label distinto                     | E2E                    |
| UI-07  | Grid/Top têm owner visível coerente, sem duplicação permanente          | UX/registry            |
| UI-08  | Controls da placa ficam sobre tabs inferiores sem tapar outros overlays | Browser geometry       |
| UI-09  | Botão `(i)` abre specs/profile/origem corretos                          | E2E                    |
| UI-10  | Popup `(i)` tem keyboard/outside/Escape/focus corretos                  | A11y                   |
| NAV-01 | Home abre projeto/recuperação sem depender de auth cloud                | Integration/E2E        |
| NAV-02 | Prepare conserva cena/seleção/revisão ao navegar                        | E2E                    |
| NAV-03 | Preview navegável sem artefacto; mostra empty state correto             | E2E                    |
| NAV-04 | Live só em Workbench; câmara/telemetria/3D claramente diferenciados     | UX/E2E                 |
| NAV-05 | Chat conserva conversa/contexto apropriado nas quatro páginas           | Integration/E2E        |

### 19.3 Materiais

| ID     | Critério verificável                                                       | Nível              |
| ------ | -------------------------------------------------------------------------- | ------------------ |
| MAT-01 | Mesh/Slicer diferem em apresentação sem alterar geometria                  | Render + state     |
| MAT-02 | Slicer sólido opaco, sem edges permanentes por defeito                     | Render/pixel       |
| MAT-03 | Assignment explícita não é sobreposta por loaded slot diferente            | Unit + integration |
| MAT-04 | Dois PLA de cores diferentes mapeiam por binding, não por label            | Unit + integration |
| MAT-05 | Offline/unassigned/stale mostram diagnóstico sem recolorir arbitrariamente | Integration/E2E    |
| MAT-06 | Updates do snapshot relevante refletem-se sem reload                       | Subscription/E2E   |
| MAT-07 | UV/triplanar válida e lifecycle GPU não acumula recursos                   | Render/performance |
| MAT-08 | Assignment/binding consistente entre tree, Prepare, Preview e envio        | End-to-end         |

### 19.4 CAD

| ID     | Critério verificável                                                       | Nível              |
| ------ | -------------------------------------------------------------------------- | ------------------ |
| CAD-01 | Clone cria identidade única e preserva metadata apropriada                 | Integration        |
| CAD-02 | Instance partilhada e clone independente têm efeitos distintos             | Integration        |
| CAD-03 | Drop de peça rodada mantém placement horizontal e toca mesa corretamente   | Geometry corpus    |
| CAD-04 | Orient face e centre têm resultados distintos de Drop                      | Geometry/E2E       |
| CAD-05 | Repair real corrige defeito ou reporta recusa/resultado parcial            | Worker + validator |
| CAD-06 | Boolean real produz mesh validada e provenance                             | Worker + validator |
| CAD-07 | Undo/reopen recupera add/remove/repair/boolean/material, não só transforms | Recovery           |
| CAD-08 | Edit Mode/selection/remap sobrevivem a operações topológicas               | Corpus/integration |
| CAD-09 | Add part preserva hierarchy/placement/material                             | Integration/E2E    |
| CAD-10 | Negative volume altera avaliação de fabricação, não aparência apenas       | Slice/geometry     |
| CAD-11 | Print modifier altera parâmetros regionais suportados                      | Slice corpus       |
| CAD-12 | Unsupported modifier/parameter é recusado com motivo                       | Preflight          |
| CAD-13 | Modifier stack order/apply/undo muda resultado correto                     | Geometry/recovery  |
| CAD-14 | Corpus por operação de mesh tem invariantes/expected results               | Parity             |
| CAD-15 | Concorrência UI/tool rejeita staleRevision e não corrompe seleção          | Integration        |
| CAD-16 | Frames e unidades têm roundtrip/landmarks e constraints consistentes       | Unit + corpus      |

### 19.5 Slice e Preview

| ID     | Critério verificável                                                    | Nível                |
| ------ | ----------------------------------------------------------------------- | -------------------- |
| SLC-01 | Modelo importado/posicionado gera IR e programa reais                   | Pipeline integration |
| SLC-02 | Slice abre Preview do próprio output sem import JSON manual             | Product E2E          |
| SLC-03 | Ready só após validação independente/compatibilidade                    | Integration          |
| SLC-04 | Cancel interrompe job e não publica sucesso tardio                      | Integration          |
| SLC-05 | Alteração de inputs durante job preserva source snapshot e marca stale  | Concurrency          |
| SLC-06 | Troca de placa não altera targets capturados do job                     | Integration          |
| SLC-07 | Cache key inclui todos os inputs relevantes/version/mode                | Unit/integration     |
| SLC-08 | Send de artefacto stale/missing/incompatible é bloqueado                | Integration/E2E      |
| PRV-01 | Atributos IR suportados sobrevivem ao parser/model                      | Contract tests       |
| PRV-02 | Kinds de fabricação são classificados sem tratar brim/skirt como travel | Unit/render          |
| PRV-03 | Slider respeita layer IDs não contíguos e início não zero               | Unit/E2E             |
| PRV-04 | Segment order e mapping de G-code determinísticos                       | Integration          |
| PRV-05 | Play/pause/step/scrub sobre paths do artefacto funcionam                | E2E                  |
| PRV-06 | Speed/flow/width/height legendas têm unidade/origem corretas            | Contract/E2E         |
| PRV-07 | Atributo ausente aparece indisponível, não zero inventado               | Unit/E2E             |
| PRV-08 | Single-layer/acumulative filters não mudam output                       | State/render         |
| PRV-09 | Preview placement coincide com a cena capturada                         | Geometry/frames      |
| PRV-10 | Corpus grande cumpre budgets declarados de load/scrub/memória           | Performance          |

### 19.6 Dispositivos e histórico

| ID     | Critério verificável                                                       | Nível               |
| ------ | -------------------------------------------------------------------------- | ------------------- |
| DEV-01 | Perfil declarado não é confundido com equipamento ligado                   | Provider/E2E        |
| DEV-02 | Commands usam lane real/typed ou unavailable, nunca mock silencioso        | Integration         |
| DEV-03 | Capability/limits/revision de target revalidados no execute                | Policy              |
| DEV-04 | Troca de dispositivo invalida approval anterior                            | Integration         |
| DEV-05 | Accepted e observed são estados diferentes                                 | Transport/telemetry |
| DEV-06 | Timeout/refused/offline não repetem efeito cegamente                       | Integration         |
| DEV-07 | Drying/auto-feed/slot binding têm box/slot corretos                        | Envelope + approval |
| DEV-08 | Câmara on-demand; sem preload de efeito físico                             | Integration         |
| DEV-09 | Job desconhecido não ganha representação 3D inventada                      | Product             |
| DEV-10 | Upload/start/stop têm efeito e autorização separados                       | Integration/policy  |
| DEV-11 | Testes de hardware só correm com aprovação específica e evidência redigida | Physical gate       |
| HIS-01 | Projetos, jobs e print history têm entidades/origens distintas             | Contract            |
| HIS-02 | Artefacto ausente/missing é mostrado honestamente                          | E2E                 |
| HIS-03 | Reprint cria nova intenção e valida contrato/destino atual                 | Integration         |
| HIS-04 | Histórico local funciona com cloud indisponível                            | Integration/E2E     |

### 19.7 AI, scroll, docs e produto

| ID     | Critério verificável                                               | Nível              |
| ------ | ------------------------------------------------------------------ | ------------------ |
| AI-01  | Bootstrap do provider real funciona sem segredo na webview         | Config/integration |
| AI-02  | Tool de navegação/seleção executa mesmo handler que UI             | Product E2E        |
| AI-03  | Cada ação pública tem entrada de discovery/schema/policy/tool      | Registry contract  |
| AI-04  | Backend recusa tool inválida/indisponível/revogada                 | Policy/integration |
| AI-05  | Write físico com confirm mas sem approval autenticado é recusado   | Security contract  |
| AI-06  | Approval vincula payload/target/revision/artifact e expira/consome | Integration        |
| AI-07  | Transcript mostra progress/results/denials/errors e persiste IDs   | E2E/persistence    |
| AI-08  | Ações UI atualizam contexto; ações AI atualizam snapshots/UI       | Event contract     |
| AI-09  | Troca de conversa/projeto não vaza contexto ou approval            | Isolation          |
| AI-10  | Retry/reconnect/cancel não duplica efeito físico/mutante           | Integration        |
| SCR-01 | Todos os containers inventariados têm tema de scroll               | Browser CSS        |
| SCR-02 | Light/dark e forced-colors mantêm acessibilidade                   | A11y/theme         |
| SCR-03 | Wheel/keyboard/touch/thumb funcionam                               | Input real         |
| SCR-04 | Gutter/overflow não causa jumps ou corta conteúdo                  | Responsive         |
| SCR-05 | Novos containers usam a mesma política                             | Style/contract     |
| DOC-01 | S9.12 headline/checklists/evidência concordam                      | Documentation      |
| DOC-02 | S9.13 consta do overview com escopo real                           | Documentation      |
| DOC-03 | Achados fechados têm referência a evidência e status atualizado    | Documentation      |

### 19.8 Camadas de teste

| Camada                 | Prova                                              | Não prova                                                  |
| ---------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| Unit                   | Decisão pura, schema, mapping e invariantes locais | Caller oferece inputs corretos ou backend está ligado      |
| Integration controlada | Transport/provider/worker contract e resultado     | Efeito num equipamento físico real                         |
| Demo E2E               | Shell, estado e interação sobre fixtures           | Reparação/slicing/impressão reais                          |
| Real-backend E2E       | Fluxo UI -> backend -> artefacto/snapshot -> UI    | Segurança física universal ou precisão de todos os modelos |
| Hardware smoke         | Efeito aprovado no alvo/version/condições testados | Compatibilidade com qualquer firmware/equipamento          |
| Corpus/paridade        | Operações e invariantes declaradas                 | Paridade completa com todos os recursos do Blender         |

### 19.9 Gates de implementação

**[SPEC]**

- Escolher primeiro o teste focused de comportamento, suite local ou check de contrato existente.
- Executar regressão por input real para defeitos de interação.
- Após mudanças de implementação autorizadas, cumprir o gate canónico atual:

```sh
pnpm run check
node scripts/sanitize-repo.mjs --dry-run
```

**[SPEC]**

- Consultar `package.json` atual e planos de sprint para gates adicionais de corpus/harness.
- O full gate não executa os critérios de hardware automaticamente.
- Não aceitar número de testes, presença de ferramenta ou ausência de crash como substituto dos critérios acima.
- Não exigir todas as linhas da matriz para uma correção pequena; exigir as relevantes e os contratos partilhados afetados.
- Não fechar a auditoria global enquanto requisitos relevantes estão apenas mockados ou indisponíveis sem plano explícito.

### 19.10 Definição de pronto de produto

**[SPEC]**

- User workflow correto de ponta a ponta, com provider de produção identificado.
- UI/menu/shortcut/tool parity onde a operação é pública.
- Outputs/efeitos verificáveis e status honesto.
- Invalidation/recovery/cancellation corretos.
- Schemas/migrations compatíveis e documented.
- Policy/aprovação enforced backend e segredos protegidos.
- Input real acessível, responsive e PT/EN validado.
- Regressão focused e gates relevantes aprovados.
- Evidência redigida e status canónico atualizado.
- Limitações/unsupported capabilities visíveis ao utilizador e ao agente.

## 20. Decisões pendentes e riscos de escopo

**[?]**
Estas decisões precisam de confirmação/revalidação antes da respetiva implementação, mas não impedem corrigir a âncora do menu ou eliminar overlap das barras.

| Decisão                          | Opções/limite                                                                | O que não assumir                                |
| -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------ |
| Provider de geometria de produto | Blender-primary real com adapters trusted; kernels especializados existentes | Trait/stub já equivale a worker conectado        |
| Transporte entre UI e authority  | Tauri/broker/loopback existentes, com fronteira coerente                     | Necessidade de uma nova framework inteira        |
| Binding de appearance físico     | Material de projeto primário; sync explícito por binding                     | Loaded slot pode recolorir todos os objetos      |
| Support/modifier capabilities    | Matriz por engine/version                                                    | Todo parâmetro global varia regionalmente        |
| Precisão de playback             | Ordem real; tempo estimado se modelo disponível                              | Percentagem live dá segmento físico exato        |
| UI em telas pequenas             | Overflow contextual/collapse e shell shrink                                  | App deve caber mantendo todos os botões desktop  |
| Subset CAD inicial               | Operações prioritárias com corpus                                            | “Completo” é apenas transform + boolean          |
| Approval backend                 | Registry opaco ou token autenticado segundo boundary                         | confirm/EXECUTE por si só prova humano           |
| Histórico e reprint              | IDs/artefactos/version compatíveis e nova autorização                        | Reutilizar pedido antigo sem validação           |
| Licenças/documentação legacy     | Revalidar classificações contraditórias antes de nova dependência            | Registry antigo resolve todas as exceções atuais |

### 20.1 Não objetivos desta auditoria

**[SPEC]**

- Não escolher novos fornecedores/modelos de AI ou alterar budgets de conta.
- Não rever toda a engenharia reversa/firmware/segurança de binários.
- Não certificar parâmetros físicos ou qualidade de impressão.
- Não executar calibração, upload, heat, motion, drying, feed ou print.
- Não promover recursos experimentais não planares/multi-axis.
- Não mudar licenças nem ampliar exceções legacy.
- Não reformatar/reorganizar código não relacionado.
- Não criar múltiplos documentos concorrentes de direção para o mesmo escopo.

## 21. Referências, rastreabilidade e manutenção

### 21.1 Fontes locais

**[SPEC]**

- Políticas: [AGENTS.md](../../AGENTS.md), [licenses.md](../licenses.md).
- Arquitetura preservada: [architecture.md](../architecture.md); consultar juntamente com o roadmap novo, não como descrição exclusiva do editor atual.
- Auditoria anterior: [ui-gap-audit-2026-09-30.md](../ui-gap-audit-2026-09-30.md), para contexto histórico e G1-G46.
- Estado de sprints: [sprint-overview.md](../../sprint-planning/sprint-overview.md) e planos detalhados ligados na secção 17.
- Corpus de edição: [worker.py](../../tests/corpus/worker.py), evidência de operações testadas isoladamente, não provider de produto.
- A seção 4 é o mapa de anchors de implementação; a seção 19 é o mapa de aceitação.

### 21.2 Fontes externas oficiais consultadas

**[NOTE]**
Consultadas para a auditoria de 2026-10-07. Links `latest`, wiki e branches principais podem mudar; confirmar a versão aplicável antes de depender de uma feature. Documentação de recurso nightly não é promessa de disponibilidade em release instalada.

| Ref    | Fonte                                                                                                                                                                                      | Uso neste guia                                                                     | Limite                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| REF-01 | [OrcaSlicer: keyboard shortcuts](https://github.com/OrcaSlicer/OrcaSlicer/wiki/keyboard_shortcuts)                                                                                         | Contextos Prepare/Preview, Auto Drop, filamentos e navegação por camadas/segmentos | Alguns recursos da wiki podem ser nightly/version-dependent         |
| REF-02 | [Bambu Lab: manual oficial H2D](https://csm.bblcdn.com/hub/4668d0ca43994ff3bff4b37f1a65c2e7.pdf)                                                                                           | Separação do fluxo de slicing/preview e análise de resultado                       | Referência de comportamento, não perfil universal de máquina        |
| REF-03 | [Bambu Studio: GUI_ObjectList.cpp](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/GUI_ObjectList.cpp)                                                                  | Referência de organização/ações por objeto                                         | Study-only; não copiar/importar/adaptar código contra policy        |
| REF-04 | [Bambu Studio: GCodeViewer.cpp](https://github.com/bambulab/BambuStudio/blob/master/src/slic3r/GUI/GCodeViewer.cpp)                                                                        | Referência de ligação entre visualização e output                                  | Study-only; versão da branch deve ser verificada                    |
| REF-05 | [Anycubic: Slicer Next update record](https://wiki.anycubic.com/zh/software-and-app/new-page-anycubic-slicer-beta%28orca-version%29/anycubic-slicer-next-%28orca-version%29-update-record) | Workbench, remote print, machine control e monitoring                              | Não extrair defaults/firmware da página para produção               |
| REF-06 | [Blender: editing mesh objects](https://docs.blender.org/manual/en/5.2/modeling/meshes/editing/index.html)                                                                                 | Vocabulário de operações de vértice/aresta/face                                    | Referência de paridade, não promessa de implementação completa      |
| REF-07 | [Blender: mesh modeling introduction](https://docs.blender.org/manual/en/latest/modeling/meshes/introduction.html)                                                                         | Distinção Object/Edit/Sculpt                                                       | Confirmar versão do worker instalado/pinado                         |
| REF-08 | [Blender: modifiers introduction](https://docs.blender.org/manual/en/latest/modeling/modifiers/introduction.html)                                                                          | Stack não destrutivo, ordem, apply e mesh avaliada                                 | Não confundir com modificadores de impressão                        |
| REF-09 | [Radix Context Menu](https://www.radix-ui.com/primitives/docs/components/context-menu)                                                                                                     | Submenus, keyboard e collision handling                                            | Confirmar pacote/version/API antes da implementação                 |
| REF-10 | [AI SDK: chatbot tool usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage)                                                                                                         | Server/client tools, transcript estruturado e interação                            | Adaptar ao protocolo/versão instalado, não copiar modelo de exemplo |
| REF-11 | [MCP: tools specification 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)                                                                               | Schemas, resultados e annotations não equivalentes a autorização                   | Versão específica consultada; não descrita como latest              |
| REF-12 | [MDN: scrollbar-color](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scrollbar-color)                                                                              | Theme, contraste e forced-colors                                                   | Browser/WebView support deve ser testado                            |
| REF-13 | [MDN: scrollbar-width](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/scrollbar-width)                                                                              | Espessura/fallback/acessibilidade                                                  | Não esconder scroll como solução de layout                          |

**[SPEC]**

- Referências externas são comparação/informação; a policy local rege uso de código/dependências.
- Não há trechos de código dos slicers copiados neste guia.
- Na verificação documental, algumas páginas de Blender devolveram erro na abertura direta e a página de Anycubic não forneceu texto nessa modalidade; o conteúdo relevante foi confirmado pelos resultados de pesquisa no domínio oficial.
- Não assumir licenças ou disponibilidade atuais apenas pelo nome de um projeto.
- Se uma fonte não puder ser extraída, usar referência primária alternativa e declarar o limite; não inventar comportamento.

### 21.3 Atualização pelos agentes

**[SPEC]**

- Manter IDs de achados e critérios estáveis.
- Uma correção adiciona evidence/commit/test/provedor ao achado, sem apagar a causa histórica.
- Alteração de arquitetura proposta exige decisão explícita e atualização dos contratos afetados.
- Corrigir afirmações que deixaram de corresponder ao código atual; preservar baseline e data de revisão.
- Não declarar este documento como substituto do índice canónico de sprints.
- Quando todos os critérios do domínio estiverem cumpridos, atualizar status com evidência de produto e limitações remanescentes.

### 21.4 Changelog

| Versão | Data       | Alteração                                                                                                                                                                  |
| ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0.0  | 2026-10-07 | Auditoria da sessão expandida para guia de agentes, com 15 achados, contratos-alvo, matriz de requisitos, orientação por domínio, mapa de sprints e critérios de aceitação |

**[SPEC]**
Decisão final: uma autoridade real de projeto, um catálogo partilhado de operações, quatro páginas com responsabilidades claras e resultados comprováveis. Menus e barras só fecham o pedido quando CAD, Preview, Workbench e chat executam operações reais e coerentes sobre os mesmos dados.
