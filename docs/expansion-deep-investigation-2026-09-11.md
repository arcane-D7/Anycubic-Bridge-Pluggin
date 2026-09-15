# Expansão aprofundada — para além dos P1–P5 (investigação 2026-09-11)

Status: **investigação completa**, com probe live `docs/evidence/expansion-probe-*.json`.
Este documento estende `expansion-audit-2026-09-11.md` (P1–P5) e
`expansion-research.md` (roadmap) com descobertas novas: endpoints/conta
live-confirmados ainda não expostos, ordens em bruto da referência
`anycubic-cloud-api`, métricas de vida/custo, e adaptações sobre o ecossistema
(Bambu Research Group, Spoolman/OpenTag3D, Obico/GuardianEye).

> Agnóstico à impressora: a unidade de teste é a Kobra S1 cloud id <PRINTER_ID>
> (machine_type 20025, fw <FW_VERSION>); cada endpoint/ordem abaixo é comum à linha
> Anycubic FDM, com IDs válidos por modelo — revalidar com `printer_property_catalog`.

---

## 0. Resumo executivo — o que a investigação encontrou para além dos P1–P5

| Nº      | Nome                                                                                                                                       | Valor                                                                    | Risco      | Esforço |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------- | ------- |
| **N1**  | `account_print_history` / `account_print_metrics` (histórico de 65 jobs, filtros por status, razões de falha)                              | Alta — diagnostics e análise de falhas                                   | read       | Baixo   |
| **N2**  | `account_cloud_store` (quota 2GB, usado/byte, `user_file_exists`)                                                                          | Média — preflight uploads                                                | read       | Baixo   |
| **N3**  | `printer_lifetime_metrics` (`print_count`, `material_used` kg, `print_totaltime`, `video_taskid`, MAC, MAC address)                        | Alta — dashboards, custo por máquina                                     | read       | Baixo   |
| **N4**  | `printer_status_snapshot` (`printersStatus` completo incl. `parameter`, `features[]`, `multi_color_box` slots, `machine_data.res_x/res_y`) | Alta — painel único                                                      | read       | Baixo   |
| **N5**  | `account_cloud_files` (`userFiles` com estimate/material/layer/supplies/dimensions/thumbnail)                                              | Alta — fila e preview                                                    | read       | Baixo   |
| **N6**  | `printer_error_list` (`/v3/work_project/getErrorList`)                                                                                     | Média — incident response                                                | read       | Baixo   |
| **N7**  | `printer_video_thumbnail_list` (timelapse / video_taskid)                                                                                  | Média — mídia                                                            | read       | Médio   |
| **N8**  | `printer_edge_ops` — **STOP_PRINT_FORCE (44)** + `SET_PRINT_STATUS_FREE (901)`                                                             | **Muito alta para recuperação de incidentes** (destrava tarefas pegadas) | job/write  | Médio   |
| **N9**  | `ace_precise` — **`FEED_FILAMENT_FINISH` (1209)**, `REFRESH_SLOT (1210)`, retract                                                          | Alta — fluxos de alimentação/retracção completos                         | state      | Baixo   |
| **N10** | `firmware_ops` — **printer rename, OTA printer/ACE (update_version)**                                                                      | Média                                                                    | write      | Médio   |
| **N11** | `printer_file_preview` (gcode 3MF + thumbnails + `filament_used_g/mm/cm3` por cor)                                                         | Alta — preview/validação                                                 | read       | Baixo   |
| **N12** | `camera_cloud_agora` (RTC `shengwang_rtc_support`, `video_taskid`)                                                                         | Alta — câmara cloud sem LAN                                              | read       | Alto    |
| **N13** | `spool_multi_vendor` (leitor PC NFC universal + OpenTag3D + decode Bambu)                                                                  | Alta — inventário multi-marca                                            | read       | Alto    |
| **N14** | `printer_event_webhooks` (estado, AI alert, spool low, job finished)                                                                       | Média-alta — integração                                                  | read/write | Médio   |
| **N15** | `anycubic_statsd` (export Prometheus/OpenMetrics das métricas acima)                                                                       | Média                                                                    | read       | Baixo   |
| **N16** | `license/DFU self-test` (`GET_AUTO_OPERATION`, `SET_DEVICE_SELF_TEST`, `RELEASE_FILM`)                                                     | Baixa                                                                    | read/write | Alto    |

Prioridade recomendada (batch inicial): **N1+N2+N3+N4+N5+N6** — todos read-only,
live-confirmados pelo probe, alavancam os 5 verificadores existentes sem criar
dever de execução. Depois **N8+N9** (controlo) com `confirm:`/`EXECUTE` gated.
Depois N11+N15 (preview/custo).

---

## 1. Probe live — endpoints de conta/impressora **confirmados** mas **ainda não expostos**

`scripts/expansion-probe.mjs` (read-only) executou contra a conta real:

| Endpoint                            | Estado                                                 | Shape chave                                                                                                                                                                                                       |
| ----------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /work/index/getUserStore`     | ✅ reply                                               | `used_bytes=77551220, total_bytes=2147483648 (2GB), used=73.96MB, user_file_exists=true`                                                                                                                          |
| `GET /v2/project/printHistory`      | ✅ reply array(3)                                      | `pageData.total=65` jobs; `print_status` (2=finished, 3=failed+`reason`)                                                                                                                                          |
| `GET /work/printer/printersStatus`  | ✅ reply array(1)                                      | `print_count=67`, `material_used="2.97kg"`, `print_totaltime="129hour35min"`, `video_taskid=0`, `machine_mac`, `parameter.{curr_nozzle_temp,curr_hotbed_temp}`, `features[]`, `multi_color_box[]` slots completos |
| `GET /v2/printer/all`               | ✅ reply object(2)                                     | —                                                                                                                                                                                                                 |
| `GET /v3/work_project/getErrorList` | ✅ reply array(5)                                      | razões de falha, incluindo 10115/10116                                                                                                                                                                            |
| `GET /work/project/getProjects`     | ✅ reply array(3)                                      | listagem de projetos (não só o corrente)                                                                                                                                                                          |
| `GET /work/index/userFiles`         | ✅ reply array(10)                                     | ficheiros cloud com md5/url/thumbnail                                                                                                                                                                             |
| `GET /v1/user/profile/userInfo`     | ❌ erro HTTP (caminho real é `/user/profile/userInfo`) | —                                                                                                                                                                                                                 |

Order ids read-only (MQTT) — todos aceites (cada um devolve msgid; o reply vem
por MQTT; não são garantia de sucesso): `1214 axis`, `1231 peripherie`,
`1232 light`, `1206 multiColorBox`, `103 local_files`, `101 usb_files`.

Evidência: `docs/evidence/expansion-probe-1789139915829.json` (redactado, sem
credenciais; URLs e tokens redactados; `user_id`/`key` presentes mas sem segredo).

**Valor concreto:** estes endpoints alimentam (a) histórico de 65 impressões com
razões de falha (dashboards, incident-response), (b) quota de storage para
pré-validar uploads, (c) métricas de vida (`print_count`, `material_used`,
`print_totaltime`) para custo por máquina, (d) snapshot completo de slots ACE e
features como painel único.

---

## 2. Ordens em bruto da referência `anycubic-cloud-api` (AnycubicOrderID IntEnum)

A referência (GPL-3.0) documenta muitos ids que o nosso `ORDER`/`LEGACY_ORDER_IDS`
ainda não contém. NENHUM deve ser usado sem validação live (o histórico
10115/order-id prova isso); candidatos a investigar por ordem de valor:

| ID        | Nome                                               | Uso provável                                                                                                                             |
| --------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **44**    | `STOP_PRINT_FORCE`                                 | Paragem forçada — recuperação de tasks presas (o nosso STOP=4 funcionou, mas um force-stop pode destravar estados de "resuming/stoping") |
| **901**   | `SET_PRINT_STATUS_FREE`                            | Limpar estado de impressão da impressora (marcar como livre) — direct-to-incident                                                        |
| 202       | `MOVE_AXLE_TO_COORDINATES`                         | Movimento absoluto (cuidado: motion, precisa home)                                                                                       |
| 1210      | `MULTI_COLOR_BOX_REFRESH_SLOT`                     | Refresh de slot ACE                                                                                                                      |
| 1209      | `FEED_FILAMENT_FINISH`                             | Terminar alimentação (a nossa `ace_feed` faz feed; falta o finish)                                                                       |
| 1001/1260 | `CAMERA_OPEN`                                      | Open camera (cloud/Agora)                                                                                                                |
| 602       | `GET_DEVICE_SELF_TEST`, 601 `SET_DEVICE_SELF_TEST` | Self-test de arranque                                                                                                                    |
| 701/702   | `SET/GET_AUTO_OPERATION`                           | Auto-op M7                                                                                                                               |
| 801       | `RESET_RELEASE_FILM`, 802 `GET_RELEASE_FILM`       | Libertação de filme (resina)                                                                                                             |
| 1228      | `GET_M7_AUTO_OPERATION`                            | Auto-op M7                                                                                                                               |
| 1229/1230 | `EXTFILBOX` / `GET_EXTFILBOX_INFO`                 | Extrusor externo                                                                                                                         |
| 11/12     | `IGNORE`/`DETECT`                                  | —                                                                                                                                        |

Ferramenta a adicionar (read-only do catálogo): `printer_order_registry`
— junta `LEGACY_ORDER_IDS` + estes ids com o `evidence` level, para que a
investigação e a UI possam decidir o que validar sem adivinhar.

---

## 3. Métricas de vida e custo (N3) — dados físicos confirmados no probe

`printersStatus` devolve já agregados (da fábrica):

```
print_count: 67
material_used: "2.97kg"
print_totaltime: "129hour35min"
machine_mac: B0-8C-B3-51-B0-96
video_taskid: 0
machine_data: { res_x: 11520, res_y: 5120, pixel: 34.4, size_x:250, size_y:250, size_z:260 }
parameter: { curr_nozzle_temp:39, curr_hotbed_temp:34 }
```

Uso: custo por kg (multiplicar por preço do filamento), tempo acumulado =
manutenção preventiva (lubrificação, substituição de bicos a intervalos),
comparação entre múltiplas impressoras na conta (todas as entradas de
`printersStatus`). Também dá `video_taskid` — o id que abre a câmara cloud/Agora.

---

## 4. Câmara cloud / Agora (N12)

- `features.shengwang_rtc_support` (`true`) → a impressora publica `video_taskid`
  quando uma sessão RTC está activa.
- O fluxo cloud-camera (Agora WebRTC) não está tocado: é o caminho para ver a
  câmara **mesmo em modo cloud** (sem LAN). O nosso `printer_lan_camera` depende
  de LAN; com Agora podemos ter snapshot/timelapse via cloud.
- `CAMERA_OPEN (1001/1260)` é a ordem para iniciar; `video_taskid` autoriza.
- `getVideoThumbnailList` dá os thumbnails de timelapse gravados.

Prioridade: alta para quem quer watchdog sem LAN mode; esforço médio-alto
(WebRTC). Alternativa imediata: usar o `rtspUrl` exposto no `info/report` quando
a impressora tiver LAN; documentar a limitação.

---

## 5. NFC / spool multi-vendor (N13) — adaptação sobre pesquisa confirmada

### Estado (já documentado em `expansion-research.md`: ACE = leitor, nunca escritor)

O ACE só parseia tags de formato Anycubic e não publica bytes crus/UID.

### Novidades desta investigação (Bambu Research Group + OpenTag3D)

- **Bambu Lab RFID**: tags MiFare 1K com **UID não encriptado**; as chaves podem
  ser **derivadas do UID por KDF** (HKDF-SHA256) — não é preciso sniffing;
  script público `deriveKeys.py`. Formato documentado por blocos (bloco 1 =
  material ID; bloco 2 = filament type; bloco 5 = peso+cor; bloco 6 =
  temperaturas+secagem; bloco 8 = nozzle; bloco 12 = data produção; bloco 9 =
  tray UID; 10-15 = assinatura RSA-2048).
- **RSA-2048 signature**: é a barreira a escrever tags Bambu (rejeita qualquer
  tag alterada). Clonagem possível (mesmo UID+dados+assinatura), custom tags
  impossível sem a chave privada → confirma o princípio do projeto: **ACE é
  leitor; tags personalizadas = NTAG virgem com schema próprio**.
- **Creality RFID**: formato ASCII simples (batch, data, cor, material) —
  leitor universal pode decodificar sem chaves.
- **OpenTag3D** (`opentag3d.info`): proposta de standard aberto para tags —
  alvo a integrar no leitor PC.
- **Ferramentas PC**: Proxmark3 (Iceman fork, `fm11rf08s_recovery`) ou Flipper
  Zero bastam; o daemon PC/SC do nosso desenho original continua a ser o
  caminho certo — alvo de integração: `bambu.parse.py` port para Node.

**Entrega proposta (N13):** `nfc_scan` (via PC/SC → UID + bloques crús /
formato Anycubic vía MQTT ACE), `spool_resolve` (UID → registry local ou
Spoolman REST), `spool_bind` opcional (só via `edit_status:1` legítimo). O
decoder multi-marca é uma lib separada (não toca no ACE).

---

## 6. Integração de terceiros / adaptações melhores que o existente

### 6.1 Webhooks de eventos (N14)

O bridge MCP tem estado; falta a base de eventos. Proposta: manter um
`CloudConnectionManager` sempre ligado (já existe) e emitir eventos quando
`print_status` muda / `reason` != vazio / `consumables_percent` baixo /
`ai_settings.status` muda. Entregável: `printer_events_subscribe` (SSE ou
callback HTTP) + `printer_event_webhook` (registar URL). Deixa n8n/Node-RED/HA
reagirem sem polling.

### 6.2 Export Prometheus / OpenMetrics (N15)

`sensors` reutilizável: `printer_lifetime_gauge{print_count}`, `material_used_kg`,
`print_totaltime_hours`, `temperature{nozzle,hotbed,ace}`, `consumables_percent{slot}`.
Uma tool `printer_metrics_expose` devolve o formato texto do Prometheus →
alimenta Grafana sem instalar nada novo.

### 6.3 Cloud store preflight (N2) + upload

O upload actual valida só o tamanho local; com `getUserStore` dá para
**pré-validar espaço** e avisar antes de `lockStorageSpace`. Também expõe
`user_file_exists` → política de overwrite com consentimento.

### 6.4 Progresso por cor (N11)

`/work/gcode/infoFdm` já devolve `filament_used_g/mm/cm3` por paint index; o
`gcode_file.material_list` combina paint_info → material real. Com isso
podemos dar **consumo e custo por cor** por job e estimar restante da spool
(sem precisar de escrever no ACE).

### 6.5 Ordem registries

`printer_order_registry` (read-only) centraliza todos os ids conhecidos +
`evidence` — remove o risco de usar o nome de um id não validado como prova.

---

## 7. Priorização final e ordem de execução sugerida

### Batch 0 — read-only, zero risco ❌→✅ **IMPLEMENTADO (2026-09-11)**

`scripts/printer-expansion-tools.mjs` + injection em `dist/server.mjs`; 8 tools
registadas e 74/74 testes verdes (`node --test`); todas validadas live via
`scripts/expansion-smoke.mjs` e `node scripts/mcp-call.mjs` — evidência em
`docs/evidence/expansion-probe-*.json` e secção própria no `VALIDATION.md`.

1. `printer_status_snapshot` (N4) — painel único (todas as métricas acima).
2. `account_print_history` + `account_print_metrics` (N1) — histórico/falhas/custo.
3. `account_cloud_store` (N2) — quota preflight.
4. `printer_lifetime_metrics` (N3).
5. `account_cloud_files` (N5) — preview/thumbnails.
6. `printer_error_list` (N6).
7. `printer_file_preview` (N11).
8. `printer_order_registry` — doc dos ids.

Cada tool herda os padrões existentes: `confirm:` para não-leitura, redact,
`annotations.readOnlyHint`, verificação com `verify-*.mjs`.

### Batch 1 — controlo (gated por confirmação) ✅ **ENTREGUE (2026-09-11)**

9. `printer_edge_stop` (STOP_PRINT_FORCE 44 / SET_PRINT_STATUS_FREE 901) —
   `confirm:true` + `confirm_word:"EXECUTE"` (safety job); mode `force` apenas
   num estado genuinamente preso na unidade sacrificial.
10. `ace_feed_finish` (1209) / `ace_refresh_slot` (1210) — `confirm:true`
   (safety state); validação via feed real na unidade livre.
11. `printer_rename` + OTA check (N10) — rename write com `confirm:true`
   (idempotente, não destrutivo); OTA **read-only** (`getPrinterUpdateVersion`,
   nunca dispara/cancela update).

### Batch 2 — infra ✅ **ENTREGUE (2026-09-11): itens 12–15**

12. `printer_metrics_expose` (N15) — Prometheus/OpenMetrics **✅ entregue**:
    counters/gauges (print_count 67, material 2.97 kg, totaltime 129.58 h,
    nozzle/hotbed, consumibles%, ACE drying status + remain seconds), texto
    0.0.4, validado live via `node scripts/mcp-call.mjs`.
    `account_cloud_projects` (`/work/project/getProjects` — 74 projetos) e
    `account_print_metrics` (outcomes + failure_breakdown + taxas; 65 jobs,
    47 finished / 18 failed, 27.69% falha / 72.31% sucesso) também entregues
    nesta leva, + preflight de quota antes do `lockStorageSpace` no upload
    (`/work/index/getUserStore`).
13. `printer_event_watch` (N14) — amostra + **diff** de `printersStatus` vs
    amostra anterior → eventos (estado, print_status, task_id, temperaturas,
    lifetime, consumíveis ACE, drying); `reset:true` limpa baseline. ✅ entregue
    (poll read-only; webhook/SSE continua fora de alcance por não haver
    callback autorizado).
14. `nfc_tag_decode`/`spool_resolve` (N13) — decoder puro offline (Anycubic SKU /
    Bambu-like / Creality ASCII) + registo de spools offline. ✅ entregue.
    Escrita em tags continua **nunca** exposta (ACE é leitor).
15. `camera_cloud_info` (N12) — suporte RTC (Agora/Shengwang), `video_taskid`,
    timelapse, **read-only** (nunca abre a câmara nem encaminha stream).
    ✅ entregue; o WebRTC real fica fora de alcance (longo, sem contrato próprio).

### Não priorizado (documentar como candidatos)

- `printer_self_test` (601/602), release-film (801/802), auto-op M7 (701/702),
  `MOVE_AXLE_TO_COORDINATES` (202) — motion / sem valor imediato; exigem
  validação muito cuidado.

---

## 8. Riscos e princípios (reafirmados)

1. **Nunca inferir segurança de um id pelo nome.** 1240 parecia START_PRINT e
   era inócuo; `STOP_PRINT_FORCE`/`SET_PRINT_STATUS_FREE` são mutações —
   validar em estado sacrificial antes de expor.
2. **`Operation successful` não prova execução.** Discriminar com
   `data.task_id` + `/v2/project/info` + MQTT.
3. **ACE = leitor; tags de fábrica = read-only; escrita só em NTAG virgem
   própria.** (Bambu: RSA-2048 torna escrita impossível de qualquer forma.)
4. **Manter o alcance read-only na primeira leva** — alavanca os 5 verificadores
   e mantém o `printer_read_all` como fonte de verdade.
5. **Redact** em todos os outputs (URLs, tokens, `key`, `user_id`).
6. Ficheiro de probe fornecido: `scripts/expansion-probe.mjs` (read-only,
   guardado redactado em `docs/evidence/`).

---

## 9. Verificação

```powershell
node scripts/expansion-probe.mjs          # live read-only (já correu; neste doc)
node --test tests/*.test.mjs              # 74 tests (62 + 12 novos Batch 0)
node scripts/verify-command-bus-mcp.mjs   # 62 tools / 18 commands (após cada batch)
node scripts/verify-full-read-mcp.mjs     # 54 tools / 553 paths
node scripts/verify-cloud-readonly-mcp.mjs
```

Referências: `docs/expansion-audit-2026-09-11.md` (P1–P5), `docs/expansion-research.md`
(roadmap), `docs/audit-unexposed-capabilities.md` (registo de gap), evidência
`docs/evidence/expansion-probe-*.json`.
