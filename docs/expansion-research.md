# Expansão — CLI completa de controlo da impressora (investigação 2026-09-04)

> Atualização de 2026-09-10: consultar `mcp-recovery-data-contract.md` para
> resultados reais, IDs HTTP corrigidos e limitações. As hipóteses históricas
> deste documento não validam comandos de controlo nem recuperação de impressão.

Objetivo: transformar o PoC MCP numa **plataforma de controlo completa e acoplável a software terceiro**, cobrindo câmara + AI, NFC de spools (Anycubic e outras marcas), e todas as funções do firmware descobertas.

---

## 1. Fontes confirmadas

| Fonte | O que fornece |
|---|---|
| `docs/research.md` (PoC) | Protocolo Bambu-compatible: MQTT 8883 `device/<id>/request|report`, FTP 990 `sdcard/`, comandos `pushall`, `project_file`, `task_cancel/pause/resume`, `print_stop` |
| `chrisfore/anycubic_ha_local` → `research/PROTOCOL-VALIDATED.md` | **Protocolo LAN Mode nativo validado em hardware (Kobra S1 Max fw 2.6.9.6)** — handshake assinado, AES, MQTT local 9883, câmara 18088, comandos exatos |
| `Nino6689/hass-anycubic` + `anycubic-cloud-api` | ~130 entidades, 27 ações, cloud (mTLS, Agora WebRTC), `aiSettings`, `edit_status` NFC, SKU |
| `Donkie/Spoolman` | API REST + WebSocket, base comunitária SpoolmanDB, **suporte nativo emergente de leitores NFC de tags** |
| Tópico `spaghetti-detection` (GitHub) | Obico (ML local), GuardianEye (LLM vision: OpenAI/Anthropic/Gemini/Ollama local), watchdogs edge |

---

## 2. Protocolo LAN Mode nativo (validado em hardware real)

> Diferente do canal Bambu-compatible já implementado no PoC (`mqtts://ip:8883`). O firmware Kobra 3/4/X/S1 expõe um **serviço LAN próprio** quando "LAN Mode" está ativo no ecrã da impressora.

### Portas
| Porta | Serviço |
|---|---|
| `18910` | HTTP info/ctrl (handshake) |
| `9883` | MQTT local broker (TLS, self-signed, **sem client cert**) |
| `18088` | Câmara HTTP-FLV (H.264), on-demand |
| `80` | gkapi (compat OctoPrint 1.8.7) |

### Handshake (validado)
1. `GET http://IP:18910/info` → `{token, cn, ctrlInfoUrl, modelId, ...}`
2. `POST {ctrlInfoUrl}?ts=&nonce=&sign=&did=` com `sign = md5(md5(token[:16]) + str(ts) + nonce)`
3. Resposta → `{token: local_token, info: <b64>}`
4. AES-CBC decrypt: key = `token[16:32]`, IV = `local_token` (PKCS7) → `{broker: "mqtts://IP:9883", username, password, deviceId, ...}`
5. MQTT TLS a `IP:9883` — credenciais rotativas, nunca persistidas

### Tópicos MQTT
- Query (publicar): `anycubic/anycubicCloud/v1/web/printer/{modelId}/{deviceId}/{type}`
- Report (subscrever): `anycubic/anycubicCloud/v1/printer/public/{modelId}/{deviceId}/{type}/report`
- Tipos: `info`, `tempature` (sic), `fan`, `light`, `multiColorBox` (ACE), `print`, `status`, `file`, `peripherie`, `video`
- ⚠️ `tempature` push ~1s; `info` ~30s (lento) — consumir todos os tipos
- `print`/`multiColorBox` são activity-gated; ACE precisa de `action:"getInfo"` (não `query`) + polling

### Comandos validados (publicar no tópico web/…/{type})
| Função | type | action | data |
|---|---|---|---|
| Pausar | `print` | `pause` | `{taskid}` |
| Retomar | `print` | `resume` | `{taskid}` |
| Parar | `print` | `stop` | `{taskid:"-1"}` |
| Temps/fans/velocidade | `print` | `update` | `{taskid, settings:{target_nozzle_temp, target_hotbed_temp, fan_speed_pct, aux_fan_speed_pct, box_fan_level, print_speed_mode}}` (qualquer subconjunto) |
| Luz | `light` | `control` | `{type:2, status, brightness}` |
| ACE auto-feed | `multiColorBox` | `setAutoFeed` | `{multi_color_box:[{id, auto_feed}]}` |
| ACE secagem start/stop | `multiColorBox` | `setDry` | `{multi_color_box:[{id, drying_status:{status:1|0, target_temp, duration}}]}` |
| Câmara start/stop | `video` | `startCapture`/`stopCapture` | `null` |
| Info ACE | `multiColorBox` | `getInfo` | — |
| Posição cabeça | (ordem 1214) | — | — |

Estado do ciclo de vida (`project.state`): `preheating → auto_leveling → vibrating → flow_calibrating → printing → pausing → paused → resuming → resumed → stopping → stoped` (sic) / `finished`. Pausa autoritativa: `project.pause` 0–4.

### Capability map (do relatório `info.data.features`)
`auto_leveling_support`, `drying_first_support`, `camera_timelapse_support`, `gcode_3mf_support`, `preheating_support`, `pre_cancel_support`, `fod_support` (AI failure detection), … — usada para feature-gating por modelo (modelId 20021–20030).

---

## 3. Câmara + AI (spaghetti e deteção de falhas)

### Duas camadas
1. **Nativa do firmware** (`fod_support`): `aiSettings`/`switch ai_failure_detection` — sensibilidade, tipo de notificação, contagem (ordem 1243, settable via MQTT/cloud). Anycubic faz a deteção no device.
2. **Nossa AI local** (independente, para qualquer impressora):
   - Stream: `video/startCapture` → `http://IP:18088/flv` (H.264) → ffmpeg/rtsp → frames
   - Modelos: Obico ML (local, open-source), YOLO ONNX fine-tuned, ou **LLM vision** (OpenAI/Anthropic/Gemini/Ollama local) — padrão GuardianEye/OctoEverywhere
   - Ações automáticas: alertar → pausar (`print/pause`) → parar (`print/stop`) — decisão configurável
   - Extra: timelapse (`camera_timelapse_support`), snapshots para relatório por camada

---

## 4. NFC de spools — ACE como leitor bruto, não fonte de verdade

> **Princípio (decisão do dono do projeto):** nunca escrever no ACE, nunca mockar identidade no slot. O ACE é usado apenas como *leitor*; os dados reais do filamento vivem no nosso registry/Spoolman.

### O que o ACE realmente fornece (via MQTT, sem escrita)
Quando uma tag é lida, o report `multiColorBox` entrega o conteúdo da tag no formato Anycubic:
`type`, `color:[R,G,B]`, `color_group` (multi-cor), `consumables_percent`, `status` (5=loaded, 4=ready), `edit_status` (`0`=tag RFID, `1`=manual, `2`=vazio), `sku` (ex. `AHPLBW-103-A30001`, 17 chars).
- Para tags Anycubic de fábrica (e ReSpool), isso **é** o conteúdo bruto da tag → tratamos como "identificador", não como verdade
- Limitação: o ACE **não publica bytes crus nem UID** da tag, e **só parseia o formato Anycubic** — tags de outras marcas (Bambu, etc.) não produzem report útil (são password-protected/formato diferente)
- Consequência: ACE como leitor funciona para tags formato-Anycubic; para o resto, leitor próprio no PC

### Leitor universal no PC (a peça nova)
- Leitor USB NFC (ACR122U/identiv, ~20-40€) via PC/SC (Windows WinSCard) → daemon no servidor
- Lê **bytes crus** de qualquer NTAG e decodifica multi-fabricante:
  - **Anycubic** — formato conhecido (material, cores, SKU)
  - **Bambu Lab** — RFID decodificado pela comunidade (OpenSpool/decode projects): material, cor, temperaturas reais, serial
  - **NTAG genérica/proprietary** — fallback por UID ou nosso schema
- **Fonte de verdade = registry local + Spoolman** (REST `POST /api/v1/spool`, websockets de consumo), keyeado por UID/SKU real da tag

### Fluxo de sincronização (decisão final — filamento personalizado manual)
> O ACE continua a ser apenas leitor. Os dados reais entram na impressora pelo **caminho legítimo de configuração manual** que o firmware/cloud já suporta — sem forjar tags, sem `edit_status: 0` falso.

1. **Ler** NFC quando existir (report do ACE ou leitor PC) → identificador bruto
2. **Resolver no registry/Spoolman** → objeto filamento REAL (marca, material, cores, peso, densidade, temperaturas, preço)
3. **Criar/enviar como filamento personalizado manual** via cloud API (o mesmo que o utilizador faz à mão no slicer) → sincroniza nativamente para o slot da impressora com os **dados reais**
   - Evidência de viabilidade: `edit_status: 1` = "entered by hand" existe no protocolo; o report observa a ação **`setInfo`** (candidata ao comando de escrita de slot — capturar payload exato em 1 sessão com a impressora)
4. **Tracking de quantidade**: a impressora já reporta `supplies_usage` (mm extrudido). Se a entrada de filamento personalizado aceitar **comprimento/peso total**, o tracking restante pode ficar **nativo na impressora**; caso contrário, calculamos no nosso lado (total − usage) — validação em hardware
5. **Tags personalizadas (futuro)**: NTAG **virgens** escritas por nós (telemóvel ou PC) — nunca tags de fábrica Anycubic. Duas opções, coexistindo:
   - **Formato Anycubic** (prova: ReSpool validado em hardware) → o ACE lê nativamente com os dados corretos
   - **Schema próprio** (nosso leitor PC lê; UID → registry)
   - App do telemóvel configura a tag 1× com o objeto específico; encostar no spool e pronto

### Fluxo (leitura sem escrita em tags de fábrica)
1. Encostar spool (no ACE ou no leitor PC) → captura do identificador bruto
2. Resolver no registry/Spoolman → dados reais: marca, material, cores, peso, densidade, faixa de temperaturas, preço
3. Tradução aplicada onde importa: perfil real no slicer (`--load-filaments`), consumo descontado da spool real, custos reais
- Schema próprio (fallback sem Spoolman): `{vendor, material, color_hex, weight_g, density, diameter, sku, tag_uid, spool_id: uuid}`

---

## 5. Acoplamento a software terceiro — arquitetura

```
                    ┌────────────────────────────┐
                    │  anycubic-bridge (core)    │
                    │  dist/server.mjs (MCP)     │
                    │  + HTTP REST (OpenAPI)     │
                    │  + MQTT bridge local       │
                    └──────┬───────┬───────┬─────┘
        MCP stdio          │REST/WS│       │MQTT republish
   ┌───────────┐   ┌───────┴──┐ ┌──┴──────┴───┐ ┌──────────────┐
   │Codex/Claude│  │Home Assist│ │n8n/Node-RED │ │Spoolman sync │
   │Copilot/CLI │  │(sensor/   │ │(automação)  │ │(inventário)  │
   └───────────┘   │ control)  │ └─────────────┘ └──────────────┘
                   └──────────┘
   Plugins internos: camera-watchdog (AI), nfc-daemon, job-queue, cost-tracker
```

- **CLI**: binário `anyctrl` (comandos: `status`, `print`, `pause`, `stop`, `temp`, `fan`, `light`, `dry`, `ace`, `file ls/up/print`, `camera snap/stream`, `nfc read/write`, `spool sync`, `ai watch`)
- **REST + OpenAPI**: mesmas superfície das tools MCP, servida em 127.0.0.1 (token por sessão) → qualquer linguagem
- **MQTT bridge**: republicar reports do printer num broker local (mosquitto) → Home Assistant/n8n/Node-RED sem lógica própria
- **Webhooks**: eventos (`job.started/finished/failed`, `ai.alert`, `spool.low`) → notificações, dashboards
- **Modo cloud**: manter o caminho atual (workbench API + Agora) como transporte alternativo

---

## 6. Roadmap proposto

| Fase | Entrega |
|---|---|
| 1 | Cliente LAN Mode nativo (handshake+AES+MQTT 9883) ao lado do atual; `printer_status` unificado |
| 2 | Comandos completos: temps/fans/speed/light/dry/autofeed/pause/resume/stop/head-position + `getInfo` ACE polling |
| 3 | Câmara: `startCapture`→FLV→snapshots; watchdog AI (Obico local + LLM vision opcional) com auto-pause |
| 4 | NFC daemon (PC/SC) + schema de tags + sync Spoolman + binding spool→perfil filamento |
| 5 | REST/OpenAPI + MQTT bridge + webhooks + CLI `anyctrl` |
| 6 | Timelapse, fila de jobs, custos, custos/nozzle-wear metrics (Prometheus) |

### Riscos
- LAN Mode **remove a impressora da conta cloud** (re-pairing manual para voltar) — tornar opcional e documentar
- `stop` inferido (não capturado diretamente) — confirmar em primeiro uso
- Parsers devem seguir o **tipo do tópico**, não o campo `action`
- Tags Anycubic de fábrica são read-only; escrita apenas em tags próprias
