# Anycubic Slicer Next Control

PoC de plugin local para o Codex/ChatGPT controlar com segurança o Anycubic Slicer Next no Windows através de tools MCP estruturadas.

O projeto abre o app, carrega STL/3MF, descobre perfis locais, aplica overrides básicos de slicing, inicia o slice e exporta G-code e/ou `.gcode.3mf`. Suporta também remote print LAN (MQTT + FTP) para impressoras Anycubic compatíveis, com envio do ficheiro para o SD card e início/controlo do trabalho a partir da máquina local.

## Estado do PoC

- Detecta automaticamente `C:\Program Files\AnycubicSlicerNext\AnycubicSlicerNext.exe` e aceita override por variável de ambiente.
- Usa a CLI nativa herdada do OrcaSlicer (`--load-settings`, `--load-filaments`, `--slice`, `--outputdir`, `--export-3mf`) apenas para slice local de G-code.
- **Orquestra o app GUI** para export compatível com o firmware: `slice_via_app` abre o app, carrega o modelo e usa os controlos visuais do próprio app (Slice all / Export G-code) via UI Automation, porque a CLI não gera os metadados que a impressora exige (thumbnails, `print_sequence`, `paint_info`).
- Inspeciona a janela via Windows UI Automation e expõe um conjunto pequeno e seguro de ações (`uia_tree`, `uia_read`, `uia_click`, `uia_type`, `uia_key`) com allowlists fixas — nunca coordenadas nem teclas arbitrárias.
- Controla impressoras na LAN via MQTT/TLS (porta 8883) e FTP/TLS (porta 990), com o access code nunca registado em logs.
- Leitura da conta Anycubic via cloud workbench API (`account_login`, `account_devices`, `account_files`), com token JWT capturado do app em memória e guardado DPAPI-encrypted. O envio por `account_print` está bloqueado para repetição de ficheiros históricos até corrigir o contrato cloud documentado no [incidente de 2026-09-07](docs/cloud-history-reprint-incident-2026-09-07.md).
- Cria um plano temporário antes de executar e grava cada resultado numa pasta nova, evitando sobrescrita.
- Valida extensões, tamanho, caminhos canónicos, perfis e roots permitidos.
- Regista apenas metadados mínimos num audit log local; não guarda prompts nem tokens.

## Arquitetura

```text
ChatGPT / Codex
      |
      | MCP stdio; schemas estritos; aprovação do host
      v
Servidor local TypeScript
      |
      +-- Policy: allowlists, limites, plano -> confirmação, audit log
      |
      +-- Orquestração do app GUI (via de export compatível)
      |      +-- slice_via_app: abrir app, carregar modelo,
      |      |   Slice all + Export G-code (UIA allowlist)
      |      +-- export-scan: localizar ficheiro novo e validar
      |          estrutura (thumbnail / print_sequence) antes de usar
      |
      +-- Adaptador CLI (secundário: G-code local)
      |      +-- carregar perfis JSON
      |      +-- overrides básicos
      |      +-- slice local
      |      +-- G-code / G-code.3MF
      |
      +-- Ponte Windows UIA/Win32 (inspeção + ações seguras)
      |      +-- detetar/inspecionar janela
      |      +-- ações allowlist (Slice all, Save Project, Export G-code, ...)
      |
      +-- Remote print LAN (MQTT/FTP) e Cloud (workbench API)
```

O MCP orquestra o app em vez de replicar o slicer: o firmware rejeita ficheiros `.gcode.3mf` produzidos só pela CLI (erro 10115) porque lhes falta a estrutura que a própria app GUI gera. A UI wxWidgets expõe controlos via UI Automation com nomes localizados; por isso a camada UIA usa apenas uma allowlist pequena e robusta de ações, nunca coordenadas arbitrárias.

Mais detalhes: [docs/architecture.md](docs/architecture.md) e [schemas/tools.json](schemas/tools.json).

## Codex local vs. ChatGPT

- **Codex desktop/local:** usa diretamente o servidor MCP stdio incluído em `.mcp.json`.
- **ChatGPT Developer Mode:** a OpenAI exige um endpoint HTTPS público ou o **Secure MCP Tunnel**. Para manter o slicer privado, ligue o tunnel a este servidor stdio; depois registe a conexão no ChatGPT e use o ID `plugin_asdk_app...` numa futura `.app.json`.
- O PoC não abre porta TCP e não cria um tunnel automaticamente. Essa escolha evita exposição acidental da máquina e precisa de configuração/autorização do workspace do utilizador.

O manifesto `.codex-plugin/plugin.json` e a pasta `skills/` são específicos do ecossistema Codex. O servidor em `dist/server.mjs`, porém, é um servidor MCP stdio normal e pode ser usado por qualquer cliente MCP que execute processos locais na mesma máquina Windows.

### Claude Code

Extraia o plugin para uma pasta estável, por exemplo `C:\Tools\anycubic-slicer-next-control`, e registe o servidor nativo:

```powershell
claude mcp add anycubic-slicer-next --scope user -- cmd /c node "C:\Tools\anycubic-slicer-next-control\dist\server.mjs"
claude mcp list
```

No Windows nativo, `cmd /c` evita problemas de inicialização do processo local. O Claude Code pedirá confirmação antes de usar uma configuração MCP de projeto.

### GitHub Copilot CLI

```powershell
copilot mcp add anycubic-slicer-next -- node.exe "C:\Tools\anycubic-slicer-next-control\dist\server.mjs"
copilot mcp list
```

Também é possível colocar a configuração em `%USERPROFILE%\.copilot\mcp-config.json`. No VS Code, use `.vscode\mcp.json` com a mesma command/args, mas a chave superior esperada pelo editor é `servers` em vez de `mcpServers`.

Claude Code e Copilot usarão as tools MCP, mas não a skill Codex nem o manifesto `.codex-plugin`. O cliente precisa rodar no Windows onde o Anycubic Slicer Next está instalado; agentes cloud/remotos não conseguem controlar esse aplicativo local sem uma ponte explícita.

## Como usar o MCP (guia de utilização)

O servidor expõe **86 tools MCP** (ver `schemas/tools.json`) que cobrem o ciclo completo: inspecionar → abrir → fatiar → exportar → imprimir. Todas as tools são chamadas pelo agente (Codex, Claude, Copilot, …) através do protocolo MCP stdio; o fluxo é sempre o mesmo:

### 1. Modelo de confirmação (gating)

O servidor é **local-first e "least privilege"**: nenhuma tool que tenha consequências (mover eixos, aquecer, iniciar impressão, enviar comandos, escrever ficheiros) executa sem aprovação explícita.

| Classe de segurança | Exemplos                                                                                                        | Exigências                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `read`              | `inspect_slicer`, `printer_status`, `account_cloud_diagnostics`, `printer_read_all`, `slicer_profiles`          | nenhuma — executam de imediato                  |
| `state`             | `printer_connection_close`, `ace_feed_finish`, `ace_refresh_slot`, `printer_rename`                             | `confirm: true`                                 |
| `thermal`           | `temperature_set` (via `printer_command_send`)                                                                  | `confirm: true`                                 |
| `motion` / `job`    | mover eixos, `printer_command_send` (motion), `printer_print_start`, `printer_edge_stop`, `account_print_local` | `confirm: true` **e** `confirm_word: "EXECUTE"` |

Regra prática: se a tool pedir `confirm`, o agente deve mostrar o plano/parâmetros ao utilizador e **aguardar aprovação explícita** antes de chamar. Um default de schema (`confirm: false`) nunca dispara uma ação.

### 2. Jornada típica — fatiar e exportar

```
1. inspect_slicer({})                    → confirma instalação, processo e roots permitidos
2. slicer_profiles({ kind: "machine", query: "Kobra S1" })
3. open_model_in_slicer({ path: "<abs>\\modelo.stl|3mf", confirmation: "RUN" })
4. prepare_slice_job(...)                → devolve o plano (camada, infill, walls, suportes)
5. run_slice_job({ job_id, confirmation: "RUN" })
```

- O fluxo **recomendado** para exportar um ficheiro que o firmware aceita é `slice_via_app` (o app gera thumbnails, `print_sequence`, `paint_info` — a CLI não gera esses metadados e a impressora rejeita o ficheiro com erro 10115).
- A CLI é usada apenas como via secundária para G-code local (`--slice`, `--export-3mf`). Não assuma que o resultado CLI é imprimível sem a validação do app.
- **Nunca imprima G-code sem verificar** no preview/estado: impressora, nozzle, filamento, temperaturas, tipo de mesa e limites físicos.

### 3. Jornada típica — imprimir via LAN

```
1. discover_printers({})                 → ou fixar ANYCUBIC_PRINTER_IPS
2. printer_status({ dev_id, dev_ip, access_code })
3. send_to_printer({ ... local_file })   → envia .gcode/.3mf para sdcard/ via FTP/TLS
4. start_print({ ... })                  → inicia o trabalho (project_file)
5. printer_status(...)                   → confirmar gcode_state / mc_percent
```

### 4. Jornada típica — imprimir via cloud (por conta)

```
1. account_capture_token({})             → captura o JWT do app em memória (requer sessão iniciada)
2. account_token_status({})              → confirma dono/expiração sem ecoar segredo
3. account_login({})                     → troca token por sessão cloud (XX-Token)
4. account_devices({})                   → obter printer_key
5. account_file_upload({ local_file })   → sobe o .gcode/.3mf para a cloud
   (ou account_cloud_files({}) para escolher um ficheiro já existente)
6. printer_print_start(...)            → ordem 1 int live-validated (contrato correto)
```

> **Atenção:** `account_print` está **legado/obsoleto** (ordem 1/filetype 1, o contrato que causou o erro 10115). Para ficheiros novos use `slice_via_app` + upload + `printer_print_start`/`account_print_local`. Ver [incidente de 2026-09-07](docs/cloud-history-reprint-incident-2026-09-07.md).

### 5. Ler o estado antes de agir

O servidor privilegia **leitura antes de escrita**. Antes de qualquer comando de controle, use:

- `printer_status` / `printer_status_snapshot` — temperaturas, estado, progresso, slots ACE
- `printer_read_all` — leitura exaustiva de todas as fontes (12 MQTT + catálogo HTTP, 434 campos)
- `printer_connection_status` — saúde da sessão MQTT cloud persistente
- `printer_property_catalog` — o que cada propriedade significa (offline)
- `printer_hidden_command_map` — todos os canais de escrita e a sua classe de segurança

O `printer_command_send` aceita `light`, `fan`, `temperature`, `ace_*`, `ai_settings`, `axis`, `camera`, `print_update`, pause/resume/stop — mas cada classe respeita o gating da tabela acima.

### 6. CAD e ferramentas criativas

```
cad_open_workspace({})                   → abre o editor 3D web local (127.0.0.1, token por sessão)
cad_generate_parametric(...)             → script paramétrico (manifold) → malha
cad_generate_from_prompt({ prompt, dry_run: true })  → AI texto→CAD (sem chamar o provedor)
cad_v2_boolean({ ... })                  → booleanos CSG watertight (subtract/union/intersect)
cad_export(...) → slice_via_app(...)     → fluxo completo modelar→fatiar
cad_close_workspace()                    → para o servidor local
```

### 7. Boas práticas / segurança

- **Caminhos absolutos sempre.** Roots permitidos: `ANYCUBIC_CONTROL_ALLOWED_INPUT_ROOTS` / `ANYCUBIC_CONTROL_ALLOWED_OUTPUT_ROOTS`.
- **`confirm` por omissão é `false`** — o utilizador aprova em cada passo consequente.
- **Nunca colar access codes / tokens** no chat: o servidor usa env vars ou ficheiros DPAPI-protected. Logs redigem tokens automaticamente.
- **Lê o estado antes de agir**: use as tools `read` acima antes de qualquer `printer_command_send` / `printer_print_start`.
- Workflows de ficheiros: outputs em pasta nova por UUID (`ANYCUBIC_CONTROL_OUTPUT_ROOT`), nada é sobrescrito.

## Tools

| Tool | Efeito |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_slicer` | Deteta instalação, processo, roots e disponibilidade UIA. |
| `list_slicer_profiles` | Lista perfis JSON locais por tipo. |
| `open_slicer` | Abre o app. |
| `open_model_in_slicer` | Valida e abre um STL/3MF permitido. |
| `prepare_slice_job` | Valida tudo e devolve o comando/plano, sem executar. |
| `run_slice_job` | Executa um plano confirmado numa pasta nova. |
| `get_slice_job` | Consulta estado e artefactos. |
| `uia_tree` | Lê a árvore UIA da janela do slicer (depth/children limitados). |
| `uia_read` | Lê valores/estado dos controlos expostos. |
| `uia_click` | Invoca uma ação segura por nome (Slice plate/all, Save Project, Export G-code). |
| `uia_type` | Digita texto ASCII no controlo focado (máx. 500 chars). |
| `uia_key` | Envia uma tecla/shortcut da allowlist (Enter, Tab, Ctrl+S, ...). |
| `slice_via_app` | **Orquestra o app** (abre, ativa, Slice all + Export G-code via UIA) e localiza/valida o ficheiro exportado. Use quando o firmware rejeitar ficheiros slice-via-CLI (erro 10115). |
| `discover_printers` | Varre a sub-rede local procurando portas de impressora (8883/990/...). |
| `printer_status` | Consulta temperaturas, estado e progresso da impressora via MQTT. |
| `send_to_printer` | Envia `.gcode`/`.3mf` para o SD card via FTP (`sdcard/`). |
| `start_print` | Inicia o trabalho na impressora via `project_file` (LAN). |
| `cancel_print` | Envia `task_cancel`/`task_pause`/`task_resume`/`print_stop`. |
| `account_capture_token` | Captura o JWT (access_token) do app em memória e guarda DPAPI-encrypted. |
| `account_token_status` | Mostra quem é o dono do token e expiração, sem ecoar o segredo. |
| `account_token_clear` | Apaga o token guardado e a sessão em memória. |
| `account_login` | Troca o access_token por uma sessão cloud (XX-Token) ativa. |
| `account_devices` | Lista impressoras ligadas à conta Anycubic (remote print por conta). |
| `account_files` | Lista ficheiros na nuvem da conta (que alimenta `account_print`). |
| `account_print` | **Legado/obsoleto:** mantido por compatibilidade mas usa o contrato antigo (ordem 1, filetype 1) que causou o erro 10115. Use `printer_print_start` (contrato ordem 1 int, live-validated 2026-09-11). Ver [incidente de 2026-09-07](docs/cloud-history-reprint-incident-2026-09-07.md). |
| `account_cloud_diagnostics` | Consultas cloud allowlist: detalhe/estado/funções da impressora, histórico e detalhe, projetos, erros, metadados G-code, ACE, thumbnails. |
| `account_cloud_live_diagnostics` | Leituras MQTT cloud por tipo (axis/info/tempature/fan/light/peripherie/aiSettings/multiColorBox/print/file) com correlação de respostas e códigos do device. |
| `printer_http_readonly_diagnostics` | Sondas HTTP GET limitadas à impressora (facade OctoPrint/gkapi). |
| `printer_read_all` | **Leitura exaustiva:** todas as fontes MQTT (12) via cloud ou LAN nativa + catálogo HTTP completo (434 campos), com reconciliação campo-a-campo. Ver [printer-property-map](docs/printer-property-map.md). |
| `printer_property_catalog` | Catálogo offline das 553 propriedades conhecidas (fonte, unidade, grupo, evidência, tópico). |
| `printer_hidden_command_map` | Mapa offline de todos os canais de escrita: tópicos, envelope, comandos com payload e classe de segurança, endpoints HTTP, order ids legacy, operações não verificadas. |
| `printer_property_reconcile` | Reconciliação offline: payload capturado vs catálogo → revela campos não documentados (`extra`). |
| `printer_command_catalog` | Lista os 18 comandos executáveis (tipo, ação, payload, classe de segurança, confirmações exigidas). |
| `printer_connection_status` | Saúde da sessão MQTT cloud persistente (ligada, contadores, eventos em buffer). |
| `printer_gcode_resolve` | Resolve gcode_id → cloud file id + metadados de slice (`/work/gcode/infoFdm`). |
| `printer_command_send` | **Controlo completo por cloud:** luz, ventoinhas, temperatura, ACE (secagem/feed/auto-feed/slot), AI, eixos (mover/home/motores-off), câmara (start/stop capture), `print_update` (configurações do trabalho em curso), pausa/retomar/parar, início local. Exige `confirm: true` (+ `confirm_word: "EXECUTE"` em motion/job). |
| `printer_print_start` | **Início de impressão cloud** com o contrato ordem 1 int live-validated (2026-09-11: uma tarefa real alcançou `printing` e `finished` na unidade de teste; a hipótese 1240 nunca criava tarefa): resolve gcode, recusa impressora ocupada, `slice_param` completo, mapeamento ACE explícito e verificação pós-envio da tarefa. Ver [printer-command-bus](docs/printer-command-bus.md). |
| `account_file_upload` | **Upload de ficheiro local para a cloud** (lock → PUT presigned → claim → unlock; locks órfãos eliminados em falha). Devolve cloud file id e gcode_id quando gerado. |
| `account_print_local` | **Fluxo completo local→impressão:** upload + resolução + início ordem 1 verificado num só fluxo confirmado. |
| `printer_lan_camera` | Snapshot da câmara por LAN (HTTP-FLV porta 18088, ffmpeg argv fixo, sem shell). |
| `printer_connection_close` | Encerra a sessão MQTT cloud persistente (higiene; reconecta automaticamente no próximo comando). |
| `printer_material_catalog` | Vocabulário de materiais aceite nas escritas de slot ACE. |
| `printer_status_snapshot` | **Painel único de estado cloud** (read-only): lifetime (print count, material usado, tempo total), firmware, temperaturas atuais, features, slots ACE Pro (filamento/estado/cor). Expansão Batch 0. |
| `account_print_history` | Histórico de impressão cloud com página/limite/status e razões de falha legíveis (read-only). Expansão Batch 0. |
| `printer_lifetime_metrics` | Métricas compactas de vida útil da impressora (contador, material, tempo) (read-only). Expansão Batch 0. |
| `account_cloud_store` | Quota de armazenamento cloud (usado/total) para preflight de upload (read-only). Expansão Batch 0. |
| `account_cloud_files` | Shelf de ficheiros cloud: gcode_id, tamanho, MD5, thumbnails (read-only). Expansão Batch 0. |
| `printer_error_list` | Catálogo de defeitos da câmara/AI + códigos de razão de falha conhecidos (read-only). Expansão Batch 0. |
| `printer_file_preview` | Pré-visualização de slice por gcode_id/file_id: layers, dimensões, uso de filamento por cor (read-only). Expansão Batch 0. |
| `printer_order_registry` | Registos de order-ids do protocolo cloud: 10 validados live + 40 de referência, com aviso de colisão 1214 (read-only). Expansão Batch 0. |
| `account_cloud_projects` | Índice de projetos cloud (`/work/project/getProjects`): id, nome, modelo, tamanho, timestamps — útil como índice de recuperação/report (read-only). Expansão Batch 2. |
| `account_print_metrics` | Agregados sobre `account_print_history`: contadores finished/failed/cancelled/paused, breakdown de falhas por razão legível e taxas de sucesso/falha (read-only). Expansão Batch 2. |
| `printer_metrics_expose` | Snapshot da impressora como texto Prometheus/OpenMetrics (`printer_print_count_total`, `printer_material_used_kg`, temperaturas, consumíveis, ACE drying) — pronto para Grafana/scrape (read-only). Expansão Batch 2. |
| `printer_edge_stop` | **Recuperação de estado preso:** `mode:"force"` envia STOP_PRINT_FORCE (44); `mode:"free"` envia SET_PRINT_STATUS_FREE (901) para limpar estados de "resuming/stoping". `confirm:true` **e** `confirm_word:"EXECUTE"` (safety job). Só na unidade de teste, após leitura do estado. Batch 1. |
| `ace_feed_finish` | Conclui uma operação de alimentação de filamento ACE (FEED_FILAMENT_FINISH 1209). `confirm:true` (safety state). Batch 1. |
| `ace_refresh_slot` | Refresca os metadados de um slot ACE (MULTI_COLOR_BOX_REFRESH_SLOT 1210). `confirm:true` (safety state). Batch 1. |
| `printer_rename` | Renomeia a impressora na conta cloud (`/work/printer/edit`, N10). `confirm:true`; idempotente, não destrutivo. Batch 1. |
| `firmware_update_check` | Consulta firmware atual/latest e indica se existe atualização (OTA read-only, **nunca** dispara/cancela OTA; N10). Batch 1. |
| `printer_event_watch` | Amostra `printersStatus` e devolve o **delta** desde a amostra anterior (estado, print_status, task_id, temperaturas, contadores lifetime, slots/consumíveis ACE, drying) como eventos; `reset:true` limpa a baseline. Read-only. N14. Batch 2. |
| `nfc_tag_decode` | Decoder puro offline de registos NFC crus → Anycubic SKU / Bambu-like / Creality ASCII. Nunca escreve em nenhuma tag. Read-only. N13. Batch 2. |
| `spool_resolve` | Resolve UID/SKU contra o registo offline de spools conhecidos. Read-only. N13. Batch 2. |
| `camera_cloud_info` | Info da câmara cloud: suporte RTC (Agora/Shengwang), `video_taskid` (autoriza sessão RTC), timelapse. **Nunca** abre a câmara nem encaminha o stream. Read-only. N12. Batch 2. |
| `cad_open_workspace` | **Abre na browser uma página web 3D CAD local** (127.0.0.1, token por sessão) para modelar/editar STL para impressão. Pode pré-carregar um ficheiro. |
| `cad_close_workspace` | Para o servidor local do workspace CAD (os ficheiros exportados permanecem no disco). |
| `cad_v2_boolean` | **CSG robusto (Sprint 1):** boolean watertight (add/subtract/intersect) entre dois objectos do workspace via `three-bvh-csg`. |
| `cad_generate_parametric` | **Motor paramétrico (Sprint 2):** executa script declarativo sandboxed sobre `manifold-3d` (WASM) e materializa a malha; STL/STEP opcional. |
| `cad_generate_from_prompt` | **AI texto → CAD (Sprint 3):** traduz descrição em script paramétrico (provedor configurado por `CAD_AI_*`), valida e executa; `dry_run` pré-visualiza sem chamar o provedor. |
| `cad_select_faces` / `cad_edit_mesh` / `cad_texture` / `cad_image_to_3d` | Edição avançada no workspace CAD: seleção de faces, extrude/bevel/subdivide/sculpt, cor/texture/relevo, imagem → 3D. |
| `printer_capability_catalog` | Catálogo read-only das capacidades LAN Anycubic (queries confirmadas, comandos mapeados, câmara). |
| `printer_lan_command_preview` | Pré-visualização exata (tópico + envelope) de um comando LAN — sem conectar nem publicar. |
| `printer_diagnostics` / `printer_monitor` | Diagnóstico LAN e recolha repetida de snapshots de estado. | | `printer_lan_handshake` / `printer_lan_read` | **Transporte LAN nativo (mode LAN):** handshake assinado 18910 + leituras de relatório via broker MQTT local 9883. Read-only; falham limpo em cloud-mode. Credenciais do broker nunca persistidas. |
| `printer_lan_camera` / `camera_watch` | Câmara via HTTP-FLV (porto 18088): `mode:snapshot\|stream`, `duration_s` (1–60), `size`; `camera_watch` faz snapshots periódicos opt-in (`confirm:true`). Captura read-only para o estado da impressora. |
| `auth_setup` / `auth_id_flow_start` | Primeira instalação sem Slicer: colar token pcf/web OU fluxo email/senha assistido por browser (portal Casdoor). Valida e grava DPAPI. Ver [docs](docs/primeira-instalacao-auth-sem-slicer.md). | | `slicer_component_inventory` / `audit_gcode_recovery` | Inventário dos componentes do slicer; auditoria offline de G-code para recuperação. |

## REST/OpenAPI (fase 5) + dados persistentes

Além do MCP stdio, o mesmo leque de tools está disponível por HTTP local
(token-gated, só 127.0.0.1) para clientes genéricos (n8n, Node-RED, Home
Assistant, Postman):

```powershell
# 1) gerar/atualizar a spec OpenAPI 3.0 a partir das tools reais (79)
node scripts/generate-openapi.mjs --live
#    -> escreve schemas/openapi.json

# 2) subir o bridge REST
node scripts/rest-bridge.mjs [--port 8766] [--token <hex>]
#    POST /tools/{tool_name}   (Bearer token)
#    GET  /openapi.json
#    GET  /health
```

O token é criado em `%LOCALAPPDATA%\AnycubicSlicerNextControl\bridge-token`
(ou `PLUGIN_DATA`); se não for passado `--token`, é gerado e impresso no arranque.

**PLUGIN_DATA** (variável de ambiente): redireciona toda a pasta de dados
(tokens cloud, bridge-token, outputs) para outro disco/pasta. Resolução:
`$PLUGIN_DATA` **>** `%LOCALAPPDATA%\AnycubicSlicerNextControl` **>**
`pluginRoot/AnycubicSlicerNextControl`. Útil para não encher o disco de sistema
ou para perfis portáteis.

Diagnóstico read-only consolidado: `node scripts/diagnose.mjs
[--cloud|--lan <ip>|--http|--printers]` (substitui os antigos `probe-*.mjs`,
mantidos fora do repositório em `local-scripts/archive/`).

## Módulo CAD (modelação 3D web)

O plugin inclui um **módulo de modelação 3D web leve** para desenhar objectos para impressão 3D sem abrir outra aplicação:

- `cad_open_workspace({ input_path?, port?, idle_timeout_min?, open_browser? })` inicia um servidor HTTP **apenas em 127.0.0.1** (nunca exposto à rede), gera um **token aleatório por sessão** e abre o browser. A ferramenta devolve a URL (com token).
- A página web oferece um editor inspirado em CAD (Three.js): primitivas (caixa, cilindro, cone, esfera, prisma), transformações numéricas **em milímetros** (mover, centrar, rodar, escalar), operações booleanas CSG (união/subtração/intersecção), import STL/OBJ e **export STL/OBJ/3MF** para a pasta raiz de saída configurada.
- **Booleanos robustos (Sprint 1):** `cad_v2_boolean` executa CSG watertight via `three-bvh-csg` (MIT) sobre dois objectos do workspace — subtrair/intersetar com buracos reais (não só meias-espaços).
- **Motor paramétrico (Sprint 2):** `cad_generate_parametric` executa um script declarativo sandboxed sobre `manifold-3d` (WASM) — `box/cylinder/sphere/cone/tetrahedron`, `add/subtract/intersect`, `translate/rotate/scale/mirror` — materializa a malha no workspace e devolve STL/STEP opcional.
- **AI texto → CAD (Sprint 3):** `cad_generate_from_prompt` traduz uma descrição em linguagem natural num script paramétrico (provedor configurável por ambiente), valida, executa no motor manifold e materializa o resultado. `dry_run: true` devolve uma pré-visualização determinística **sem chamar** o provedor.
- Medidas precisas: o servidor calcula caixa envolvente, volume e área num núcleo matemático em dupla precisão, e o ficheiro exportado pode ser usado diretamente em `slice_via_app`/CLI.
- `cad_close_workspace` para o servidor (fica livre a porta); os ficheiros exportados permanecem no disco.
- O workspace CAD **não toca** na impressora nem no slicer; é apenas um editor/repositório de STL para alimentar os fluxos de slicing existentes.

### AI texto → CAD (configuração)

O provedor é lido de variáveis de ambiente do processo do servidor (nunca do browser/renderer):

| Variável          | Padrão                                       |
| ----------------- | -------------------------------------------- |
| `CAD_AI_API_KEY`  | (sem chave — tool responde "not configured") |
| `CAD_AI_BASE_URL` | `https://api.openai.com/v1`                  |
| `CAD_AI_MODEL`    | `gpt-4o-mini`                                |

Exemplo:

```powershell
$env:CAD_AI_API_KEY = "sk-..."
node dist/server.mjs
```

O fluxo completo (sem `dry_run`) chama `{base}/chat/completions`, extrai o código
de um fenced block, valida contra o sandbox partilhado e executa. A chave **nunca**
é exposta na UI nem nos logs (todos os erros passam por `redact()`).

## Instalação e build

Requisitos: Windows, Anycubic Slicer Next e Node.js 22+.

Para instalação standalone, extraia `anycubic-slicer-next-control-0.1.0.zip` para uma pasta sem espaços e preserve a estrutura interna, especialmente `dist/server.mjs`. O ZIP é um pacote de plugin; para Codex, instale-o pelo marketplace/plugin manager local e abra uma nova task. Para outros clientes, use diretamente os comandos MCP acima.

Também há um bundle `anycubic-slicer-next-marketplace-0.1.0.zip` que já contém a estrutura `.agents/plugins/marketplace.json` e `plugins/`; ele pode ser registado diretamente como marketplace local do Codex.

```powershell
pnpm install
pnpm run check
```

`pnpm run check` roda, em sequência, **build → testes → smoke → e2e UI**:

- **build:** `node scripts/build.mjs` regenera `dist/server.mjs` a partir do
  bundle congelado `vendor/server.mjs` (sem `tsc`/esbuild; idempotente). O
  `dist/` é gitignored — nunca edite o `dist/` diretamente, use o `vendor/`.
- **test:** suíte unitária (Node test runner, sem rede).
- **smoke:** `scripts/smoke.mjs` arranca o servidor MCP via stdio e valida as
  82 tools + `cad_open_workspace`.
- **e2e:ui:** `tests/e2e/cad-ui.e2e.mjs` lança um **Chromium headless real**,
  abre o workspace CAD e executa o fluxo completo em browser: add primitivas →
  boolean CSG → paramétrico → AI dry-run (zero erros de página).

O plugin já inclui `.codex-plugin/plugin.json` e `.mcp.json`. Para desenvolvimento local, adicione a pasta a um marketplace pessoal ou de repositório usando o fluxo oficial do Codex; depois instale o plugin e abra uma nova task para carregar as tools.

## Configuração de segurança

Variáveis opcionais:

| Variável                                | Valor padrão                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ANYCUBIC_SLICER_EXE`                   | Descoberta em pastas padrão do Windows.                                                          |
| `ANYCUBIC_CONTROL_ALLOWED_INPUT_ROOTS`  | Plugin, Documents, Desktop e Downloads.                                                          |
| `ANYCUBIC_CONTROL_OUTPUT_ROOT`          | `Documents\Anycubic-Control-Exports`.                                                            |
| `ANYCUBIC_CONTROL_ALLOWED_OUTPUT_ROOTS` | O root de output acima.                                                                          |
| `ANYCUBIC_CONTROL_MAX_INPUT_BYTES`      | 1 GiB.                                                                                           |
| `ANYCUBIC_CONTROL_SLICE_TIMEOUT_MS`     | 600000 ms.                                                                                       |
| `ANYCUBIC_ACCESS_CODE`                  | Access code da impressora (8 chars alfanuméricos). Usado quando a tool não recebe `access_code`. |
| `ANYCUBIC_PRINTER_IPS`                  | IPs fixos separados por vírgula, para saltar o scan da sub-rede.                                 |

Roots múltiplos usam `;`. Todos os caminhos enviados às tools devem ser absolutos. Outputs são sempre criados dentro de uma pasta nova cujo nome é o UUID do job.

## Exemplo de fluxo

1. `inspect_slicer({})`
2. `list_slicer_profiles({ kind: "machine", query: "Kobra S1" })` — use the test-unit family as an example; any Anycubic machine profile works.
3. Listar também processo e filamento.
4. `prepare_slice_job(...)` com, por exemplo, `layer_height_mm: 0.2`, `infill_density_percent: 15`, `wall_loops: 3` e `supports: false`.
5. Rever printer/nozzle/material/output.
6. `run_slice_job({ job_id, confirmation: "RUN" })`.

Nunca imprima G-code sem verificar no preview a impressora, nozzle, filamento, temperaturas, tipo de mesa, limites físicos e comandos de início/fim.

### Arquitetura (revisão: orquestrar o app, não replicar o slicer)

O MCP **executa o aplicativo** para toda a interação com o slicer — abre o app, carrega o modelo, e usa os próprios controlos visuais do app (via UIA) para fatiar e exportar. A CLI herdada do Orca é usada apenas para casos que ela suporta de forma fiável; ela **não** substitui o app nos formatos de export que o firmware exige. A tool `slice_via_app` encapsula exatamente esse fluxo: app GUI → Slice all → Export G-code → localizar e validar o ficheiro exportado.

### Remote print (LAN)

1. `discover_printers({})` para candidatos na sub-rede (ou configure `ANYCUBIC_PRINTER_IPS`).
2. `printer_status({ dev_id, dev_ip, access_code })` para confirmar alcance e temperaturas.
3. `send_to_printer({ dev_id, dev_ip, access_code, local_file })` após o slice.
4. Mostre o caminho remoto e peça aprovação explícita.
5. `start_print({ dev_id, dev_ip, access_code, task_name, file_remote_path: "sdcard:nome.gcode.3mf", ... })`.
6. `printer_status` para confirmar `gcode_state`/`mc_percent`.

### Remote print (Cloud / por conta)

1. `account_capture_token({})` — requer que o app esteja com sessão iniciada (re-login enquanto o watcher corre).
2. `account_token_status({})` para confirmar o dono/expiração.
3. `account_login({})` — troca o access_token por uma sessão cloud (XX-Token).
4. `account_devices({})` — obter o `key` (printer_key) da impressora alvo.
5. `account_files({})` — obter `file_key`/`file_id`/`gcode_id` de um ficheiro já na nuvem.
6. `account_print({ printer_key, file_key, file_id, gcode_id, file_name, ... })`.

> **Aceitação da API ≠ aceitação pelo firmware.** Enviar um `.gcode.3mf` fatiado só via CLI pode resultar em erro 10115 na impressora porque falta ao ficheiro a estrutura que o app GUI gera (thumbnails, `print_sequence`, `paint_info`, `bed_type`). Para impressão cloud de um ficheiro **novo**, use `slice_via_app` (o app gera o formato correto), depois suba o ficheiro para a conta e chame `account_print`.

## Pesquisa e limitações

- A documentação atual da OpenAI define plugins como skills + MCP server + UI opcional e recomenda schemas explícitos, anotações corretas, least privilege e confirmação para ações consequentes: [arquitetura](https://developers.openai.com/plugins/concepts/plugins), [definição de tools](https://developers.openai.com/plugins/plan/tools), [segurança](https://developers.openai.com/plugins/guides/security-privacy), [empacotamento](https://developers.openai.com/plugins/build/plugins).
- O Anycubic Slicer Next é open source e baseado no OrcaSlicer: [repositório oficial](https://github.com/ANYCUBIC-3D/AnycubicSlicerNext).
- O manual oficial confirma os fluxos visuais de Import, Slice e Export G-code: [manual Anycubic](https://wiki.anycubic.com/app/acslicer_userguide_en%281%29.pdf).
- A CLI exporta G-code como resultado do slice e pode empacotá-lo em `.gcode.3mf`.
- O remote print LAN segue o protocolo compatível com Bambu (MQTT `device/<id>/request|report` + FTP `sdcard/`), verificado no repositório oficial; necessita da impressora ligada na mesma rede e do access code. A automação foi inspecionada localmente numa instalação cujo executável reporta produto `1.4.1.2`. IDs e textos UIA não devem ser tratados como API estável.

Este projeto é independente, não afiliado à Anycubic. Nenhum código do slicer foi copiado; a integração invoca interfaces de processo e UI do app instalado.
