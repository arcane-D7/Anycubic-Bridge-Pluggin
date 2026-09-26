# Auditoria de capacidades — 2026-09-11b (segunda passagem)

Status: superfície atual 74 ferramentas verificadas ao vivo (suite verde). Esta
auditoria foca **o que ainda não existe** e **como melhorar** — nunca re-executa
escritas na impressora. A unidade de teste (Kobra S1, nuvem id <PRINTER_ID>) só é
citada como "a unidade de teste"; nenhum comando mutável foi enviado nesta
auditoria.

## 1. Estado atual (medido)

| Verificação                                            | Resultado                                 |
| ------------------------------------------------------ | ----------------------------------------- |
| `node --test tests/*.test.mjs`                         | 95 testes / 7 suites ✅                   |
| `node scripts/smoke.mjs`                               | 74 ferramentas ✅                         |
| 3 verifiers (command-bus / full-read / cloud-readonly) | 74/74/74 ✅                               |
| Printeiro da unidade de teste                          | livre (task_id null), sem impressão ativa |

Superfície (74): 10 slicer/UIA, 10 LAN/Bambu, 10 account+cloud, 22 cloud
read/print/fluxo, 5 CAD, 1 materiais, 3 NFC/spool, vários de infra.

## 2. Lacunas por fase do roadmap (`expansion-research.md`)

| Fase                                                           | Estado 2026-09-11b                                               | Observação                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Cliente LAN Mode nativo (handshake 18910 + AES + MQTT 9883) | Parcial — código existe no dist, **sem ferramenta MCP dedicada** | `queryAnycubicLanStatus`/`anycubicLanHandshake` estão compilados; só `printer_status`/`printer_diagnostics` os usam indiretamente. Falta expor `printer_lan_handshake` + `printer_lan_command` como tool. Teste unit: falha em cloud-mode (18910 fechado) — gate claro. |
| 2. Comandos completos                                          | Bem coberto (18 cmds bus)                                        | Faltam: `tempature/auto` (semântica não verificada), `print/update` incluir `print_speed_mode` como enum, `ace_getInfo` como _read_ de primeira classe (hoje é via snapshot do bus).                                                                                    |
| 3. Câmara + AI watchdog                                        | ✅ fechado (snapshot/stream + `camera_watch`)                    | Camera parametrizável (`mode/duration_s/size`) + watchdog opt-in concluídos. AI classificação fica para fase seguinte.                                                                                                                                                  | 4. NFC/spool daemon | Parcial (N13 + registro client-side + prep NFC) | Implementado 2026-09-14: registry local (`spool-registry.mjs`) com tools `spool_register`/`spool_usage`/`spool_status`/`spool_bind`/`spool_consume_from_slice` (consumo com dedup por task), e plano de escrita NFC pronto (`nfc_tag_plan`, NTAG213 formato Anycubic). Falta: leitor/escritor físico (PC/SC, Android NDEF, PN532/ACR122U), validação do layout com ReSpool em tag real, sincronização Spoolman REST. |
| 5. REST/OpenAPI + bridge + webhooks + anyctrl                  | ✅ fechado (geração + REST bridge)                               | `generate-openapi.mjs` + `rest-bridge.mjs` (token-gated, 127.0.0.1). Faltam: MQTT→webhook e CLI `anyctrl`.                                                                                                                                                              |
| 6. Timelapse / job queue / custos                              | Não iniciado                                                     | Roadmap.                                                                                                                                                                                                                                                                |
| — **Auth em primeira instalação**                              | **NÃO existe fluxo sem Slicer Next**                             | `account_login` só troca token existente; a captura exige Slicer instalado. ➡️ **Fechado por este batch.**                                                                                                                                                              |

## 3. Melhorias de maior valor (priorizadas)

### A. Auth sem Slicer Next — fechada por este batch (docs/primeira-instalacao-auth-sem-slicer.md)

- Novo script interativo `scripts/auth-login.mjs` + tool MCP `auth_setup`.
- Caminhos: (1) colar JWT `access_token` existente (pcf → MQTT), (2) colar
  `XX-Token` do portal (polling read-only), (3) `LAN Mode` (sem conta) já
  documentado. O fluxo valida via `loginWithAccessToken` + `userInfo`, grava
  DPAPI no mesmo `TokenStore` (`%LOCALAPPDATA%\AnycubicSlicerNextControl\tokens\`),
  nunca ecoa o segredo no chat.

### B. Expor cliente LAN Mode nativo como ferramentas MCP — ✅ fechado

- `printer_lan_handshake` (18910 → credenciais /ctrl; read-only, falha com
  "printer in CLOUD mode" se 18910 fechado) e `printer_lan_read` (query de
  relatórios via MQTT 9883), em `scripts/printer-lan-tools.mjs`.
- Verificado ao vivo: cloud-mode (18910 fechado) → erro limpo instantâneo.

### C. Câmara parametrizável + watchdog — ✅ fechado

- `printer_lan_camera` agora aceita `mode: snapshot|stream`, `duration_s`
  (1–60), `size`, `flv_port`.
- `camera_watch` (opt-in, `confirm:true`): poll de snapshots com intervalo e
  contagem configuráveis.

### D. REST/OpenAPI (fase 5) — ✅ fechado

- `scripts/generate-openapi.mjs` gera `schemas/openapi.json` (OpenAPI 3.0,
  1 op POST por tool, security bearer).
- `scripts/rest-bridge.mjs` serve `POST /tools/{name}`, `GET /openapi.json`,
  `GET /health` em 127.0.0.1, token-gated (hash constante-time), token em
  `%LOCALAPPDATA%\AnycubicSlicerNextControl\bridge-token`. Verificado ao vivo.

### E. Ganhos rápidos / higiene — ✅ fechado

- `cad-dev.mjs` reescrito contra o server MCP (spawna `dist/server.mjs` e chama
  `cad_open_workspace`); o import de `src/cad-server.js` foi removido.
- `probe-*.mjs` antigos movidos para `local-scripts/archive/`; novo `diagnose.mjs`
  consolida os 3 transports read-only (`--cloud`, `--lan <ip>`, `--http`,
  `--printers`).
- `PLUGIN_DATA` documentado: base de dados é
  `$PLUGIN_DATA` **>** `%LOCALAPPDATA%\AnycubicSlicerNextControl` **>**
  `pluginRoot/AnycubicSlicerNextControl` (auth, bridge-token e tokens usam a
  mesma função `dataRoot()`).

## 4. Recomendações finais

1. **Done neste ciclo**: auth sem Slicer (A), LAN native (B), câmara (C),
   OpenAPI/REST (D), higiene (E).
2. **Próximo ciclo**: NFC/spool bind + watchdog AI + MQTT→webhook + CLI
   `anyctrl`.
3. Supérficie final: 78 ferramentas (suite + smoke + verifiers verdes).

Nenhuma escrita enviada à unidade de teste nesta auditoria. Suite segue verde.
