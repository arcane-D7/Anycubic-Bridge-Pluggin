# Live Validation — Cloud API + MQTT (2026-09-04/05)

> ⚠️ **3MF CLI incompatível confirmado de novo (2026-09-05):** o `output.gcode.3mf`
> fatiado via CLI **não tem `Metadata/*.png` (thumbnails)** — o firmware rejeita com 10115. Para impressão cloud real é obrigatório `slice_via_app` (GUI) ou o fluxo
> de upload + `gcode_id` da cloud (que regenera metadados no servidor).

Validação ao vivo com a impressora ligada (unidade de teste: Anycubic Kobra S1,
cloud id `<PRINTER_ID>`, machine_type `20025`, firmware `<FW_VERSION>`, ACE Pro `model_id`
`40002`). O protocolo abaixo é **comum à linha Anycubic FDM** (Kobra 2/3/4/X/S1 e
ACE); os IDs de máquina/ordem podem variar por modelo — valide com
`printer_property_catalog` antes de assumir valores.

> A impressora estava em **modo cloud** (LAN Mode desligado — porta 18910 fechada).
> Todo o protocolo abaixo foi exercitado **pelo caminho cloud**, com credenciais
> do próprio Slicer Next.

## 1. Auth chain (100% funcional, validado ao vivo)

1. **JWT do slicer**: extraído dos logs `debug_*.log` do Slicer Next
   (padrão `eyJ...JWT...`; o token da sessão expira 2026-11-25, issuer `uc.makeronline.com`).
   O `token-watcher` existente (memória) continua a ser a via primária; os logs são fallback.
2. **login**: `POST https://cloud-universe.anycubic.com/p/p/workbench/api/v3/public/loginWithAccessToken`
   com `{device_type:"pcf", access_token:<JWT>}` → `data.token` = **XX-Token** de sessão.
   ⚠️ O endpoint antigo `/uapi/account/xxLogin` devolve 405 — foi substituído.
3. **Headers assinados** (todas as calls):
   `Xx-Device-Type: pcf`, `Xx-Is-Cn: 1`, `Xx-Nonce`, `Xx-Timestamp`,
   `Xx-Version: V3.0.0`, `Xx-Signature = md5(app_id + ts + version + secret + nonce + app_id)`
   com `app_id = f9b3528877c94d5c9c5af32245db46ef`, `secret = 0cf75926606049a3937f56b0373b99fb`
   (identidade compartilhada do slicer, extraída por hass-anycubic/GPL-3.0).
4. `GET /user/profile/userInfo` → `id`, `user_email`.
5. `GET /work/printer/getPrinters` → lista com `id`, `key` (32 hex), `machine_type`,
   `features[]` (capability map), `multi_color_box[]` (ACE completo).

## 2. MQTT cloud (100% funcional, validado ao vivo)

- Broker: `mqtts://mqtt-universe.anycubic.com:8883`, **mutual TLS**.
- Certs: `resources/mqtt-tls/{ca.crt, client.crt, client.key}` (identidade compartilhada
  do ecossistema Bambu/Anycubic, distribuída no hass-anycubic; a instalação local do
  slicer só embarca a CA).
- ⚠️ A CA é SHA-1: com OpenSSL 3 é necessário `SECLEVEL=0`
  (`NODE_OPTIONS=--tls-cipher-list=DEFAULT:@SECLEVEL=0` no Node).
- **clientId** = `md5(email + "pcf")`
- **password** = `base64(RSA-PKCS1v15(XX-Token, pubkey da CA))` — não é o JWT cru!
- **username** = `user|pcf|<email>|md5(clientId + password + clientId)`
- Subscribe: `anycubic/anycubicCloud/v1/printer/app/<machine_type>/<key>/#` e `.../+/public/...`
- Resultado: CONNACK OK, 19 eventos capturados em 12s durante impressão ativa.

### Eventos observados (reais)

- `status/report` — `workReport` com `state: free|busy`
- `file/report` — thumbnails/timelapses subindo para o S3 da Anycubic
  (`getPreSignedUrl`, `saveVideoThumbnail`) — **mostra os vídeos de timelapse por print**
- `extfilbox/report` — reportInfo do filamento externo (slot único): `type`, `color`, `loaded`

### Comandos validados (via cloud API, resposta no MQTT)

- `MULTI_COLOR_BOX_GET_INFO` (order 1250) — aceito, resposta do ACE chegou
- `QUERY_PERIPHERALS` (1230) — aceito

## 3. Estado do ACE capturado (dados reais da sessão)

| slot | tipo           | cor RGB     | consumo | sku        | edit_status |
| ---- | -------------- | ----------- | ------- | ---------- | ----------- |
| 0    | PLA High Speed | 117,120,123 | 31%     | AHHSGY-107 | 0 (tag NFC) |
| 1    | PLA            | 212,185,150 | 35%     | AHPLLB-107 | 0 (tag NFC) |
| 2    | PLA Silk       | 255,215,0   | 0%      | —          | 1 (manual)  |
| 3    | PLA            | 0,0,0       | 0%      | —          | 1 (manual)  |

`humidity=19%`, `loaded_slot=-1` (entre feeds). **Slots 2/3 com `edit_status:1` confirmam
que o caminho de filamento manual funciona e é sincronizado para a impressora** —
é exatamente por aí que entra o filamento de marca branca (NFC lido → objeto real →
`MULTI_COLOR_BOX_SET_SLOT` com `type`/`color`).

## 4. Correções aplicadas durante a investigação (bugs)

| Bug                                          | Causa                                                                                          | Correção                                                     |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `/uapi/account/xxLogin` → HTTP 405           | endpoint antigo removido                                                                       | usar `/v3/public/loginWithAccessToken`                       |
| `Connection refused: Not authorized` no MQTT | password devia ser o XX-Token **RSA-encryptado com a pubkey da CA** (sandwich MD5 no username) | `get_mqtt_login_info` portado do hass-anycubic               |
| `ERR_SSL_CA_MD_TOO_WEAK`                     | CA SHA-1 rejeitada pelo OpenSSL 3 do Node                                                      | `NODE_OPTIONS=--tls-cipher-list=DEFAULT:@SECLEVEL=0`         |
| `forge.pki undefined` (ESM)                  | node-forge é CJS                                                                               | `import forge from "node-forge"` (default export)            |
| mDNS/SSDP não anunciam a impressora          | firmware não publica serviço mDNS                                                              | descoberta por `getPrinters` (cloud) + port-scan 18910 (LAN) |

## 5. Artefactos criados

- `scripts/anycubic-cloud.mjs` — cliente cloud real (auth, orders, MQTT, JWT finder)
- `scripts/validate-cloud-live.mjs` — validação read-only ponta-a-ponta
- `scripts/probe-mdns.ps1` — descoberta mDNS (informativo)
- `resources/mqtt-tls/` — certos TLS compartilhados (CA/client)

## 6. Segurança

- Tokens/secret do slicer **não são segredo por utilizador** — são a identidade do app
  Anycubic (qualquer instalação do slicer os contém). O **XX-Token de sessão** e o JWT
  do utilizador sim, e nunca são logados nem persistidos (`.gitignore` cobre artefactos).
- Todos os comandos testados foram read-only (`getInfo`, `queryPeripherals`,
  subscrição MQTT). Nenhuma ordem de movimento/temperatura foi enviada.

---

# Testes de controlo ao vivo (2026-09-05) — impressora em standby

## ✅ Confirmado a funcionar (executado no hardware real)

### Controlo via MQTT-native (o caminho correto — como o slicer faz)

> **Descoberta crítica:** ordens de controlo devem ser **publicadas diretamente no MQTT**
> em `anycubic/anycubicCloud/v1/pc/printer/{machine_type}/{key}/{type}` com envelope
> `{type, action, timestamp, msgid, data}` — **não** via HTTP `sendOrder`.
> Via HTTP o servidor responde "Operation successful" mas a impressora não executa
> (o mesmo padrão do `MOVE_AXLE` com `project_id` extra, documentado pelo hass-anycubic).

| Comando              | Topico/action                                      | Resultado ao vivo                                       |
| -------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| **Luz ON/OFF**       | `light` / `control` `{type:2, status, brightness}` | ✅ **Executado** — `light/report` com estado confirmado |
| **Homing X/Y**       | `print` / `homexy`                                 | ✅ **Executado fisicamente** (movimento observado)      |
| **Query posição**    | `axis` / `query`                                   | ✅ `{"coordinates":{"x":0,"y":0,"z":0}}`                |
| **Ficheiros locais** | `file` / `getLocalFileList`                        | publicação aceita (resposta pendente de validar)        |

### Slicing + UIA

- Slice via **CLI + MCP** (`prepare_slice_job`/`run_slice_job`): ✅ exit 0,
  `plate_1.gcode` + `output.gcode.3mf` gerados (cubo 15mm, 1.73 g, 6m0s, 75 camadas)
- **Bug de compatibilidade corrigido:** a allowlist UIA tinha `Fatiar Disco Único/Fatiar todos`,
  mas o firmware novo chama **"Fatiar 1 placa"** → adicionado à `uia-bridge.ps1`
- **Bug de clique corrigido:** `SendInput` falhava com janela recém-ativada → fallback
  `mouse_event` nativo adicionado. **Botão Slice clicado com sucesso via UIA**
- Diálogo **"Iniciar impressão"** aberto via UIA (Impressão remota): impressora Kobra S1
  selecionada, opções Nivelamento/Timelapse/AI visíveis

### Upload cloud (100% funcional)

1. `POST /v2/cloud_storage/lockStorageSpace` → `{id: 73911458, preSignUrl: S3}` ✅
2. `PUT https://workbentch.s3.us-east-2.amazonaws.com/...` → **200** ✅
3. `POST /v2/profile/newUploadFile` → `{id: 88637611}` ✅
4. `user_files` lista o ficheiro ✅ (5 ficheiros na conta, com `gcode_id`)

## ⚠️ Pendente (padrão 10115 conhecido)

- **START_PRINT com ficheiro cloud sem slice-info na cloud** → aceite pelo server,
  não executado pelo device. O `gcode_id` precisa de ser gerado pela cloud
  (`/work/gcode/infoFdm` deu "Slice file does not exist" para o nosso upload cru) —
  a cloud só gera slice-info para ficheiros enviados **pelo próprio slicer**.
- **Consequência prática:** para imprimir via cloud, o ficheiro tem de vir do
  **fluxo GUI do slicer** (slice_via_app → diálogo Iniciar impressão), que faz
  upload com todos os metadados. O caminho 100% programático de impressão cloud
  exige replicar esse upload com metadados (fase seguinte).
- O clique em "Iniciar impressão" foi registado mas o job não arrancou — na altura
  a janela MiControl abriu sobre o slicer (interferência de foco). Re-testar com o
  ecrã livre.

## Reprint histórico cloud — falha confirmada em 2026-09-07

O `account_print` atual não reutiliza corretamente um G-code cloud já processado.
Uma tentativa com o artefacto válido `gcode_id=117442081`/`file_id=87816937` criou
a tarefa `119720568` com `model=0`, um `gcode_id` diferente e metadados de slice
vazios; a Kobra S1 recusou-a em aproximadamente um segundo com `reason=10115`.

A aplicação móvel iniciou em seguida o mesmo artefacto como tarefa `119721474`,
preservando `model=87816937`, `gcode_id=117442081`, imagem, parâmetros, dimensões e
301 camadas. Isso confirma que o ficheiro estava íntegro e que a falha era o corpo
da ordem criado pelo MCP, não o G-code.

O fluxo era experimental até 2026-09-11, quando ficou **validado ao vivo**:
`order_id=1` (int, `AnycubicOrderID.START_PRINT`), `filetype=0`, resolução prévia
de `/work/gcode/infoFdm?id=<gcode_id>`, `slice_param` completo e mapeamento ACE
criaram a tarefa `0` na impressora física (pré-aquecimento → `printing`,
92 camadas). A hipótese inicial do `order_id="1240"` foi **descartada**: o
servidor responde “Operation successful” para qualquer id, mas com 1240 nunca
criava tarefa. Análise completa:
[cloud-history-reprint-incident-2026-09-07.md](cloud-history-reprint-incident-2026-09-07.md)
e [live-validated-order1-2026-09-11.md](live-validated-order1-2026-09-11.md).

## Rate limiting

- A cloud impõe rate limit (码 `请求过于频繁` = "pedidos demasiado frequentes")
  em `loginWithAccessToken` quando chamado em rajada. Espaçar calls >10s ou
  reutilizar o XX-Token por sessão (memoize).

---

# Integração OrcaSlicer (2026-09-05) — RESOLVIDO

## Causa raiz do "Orca não reconhece a impressora"

1. **A impressora saiu da conta cloud** — o utilizador ativou LAN Mode no ecrã da
   Kobra S1, e o firmware **remove-a da conta Anycubic** (comportamento documentado:
   `getPrinters` passa a devolver `{"data":[], "total":0}`). O plugin do Orca listava
   impressoras via cloud → lista vazia.
2. **OrcaSlicer não estava instalado** (apenas resíduos + configs antigas).
3. O pedido de permissão Python (`socket.__new__`) do plugin estava pendente.

## Correções aplicadas

| #   | Correção                                                                                                                                                                      | Ficheiro                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | **Reinstalado OrcaSlicer** (nightly já nos Downloads, `/S`)                                                                                                                   | `C:\Program Files\OrcaSlicer\orca-slicer.exe`                             |
| 2   | **Fallback LAN no bridge**: `/cloud/devices?lan_fallback=1` expõe a impressora LAN como device virtual quando a cloud está vazia (handshake 18910 → AES → MQTT 9883 → status) | `dist/bridge-server.mjs` (investigado em `local-scripts/experiments/inject-lan-fallback.mjs`) |
| 3   | **Plugin com fallback automático**: `_devices()` tenta cloud primeiro; se vazio, usa `lan_fallback=1`                                                                         | `%APPDATA%\OrcaSlicer\orca_plugins\anycubic-cloud\anycubic_cloud.py`      |
| 4   | **Bridge mantido ativo** (PID persistente, porta 37645, state file sincronizado com o plugin)                                                                                 | `scripts/start-bridge.ps1`                                                |
| 5   | **Permissão Python audit (`socket.__new__`) aprovada** via SetForegroundWindow + ENTER                                                                                        | `scripts/approve-orca-dialog.ps1`                                         |

## Estado final validado

- ✅ OrcaSlicer arranca com **"Anycubic Cloud & Kobra S1"** (plugin carregado)
- ✅ **printer-agent `anycubic-cloud` registado e ativado** no Orca
- ✅ Orca Cloud Account com login (account holder, redacted)
- ✅ Aba **Device** presente; perfis Kobra S1 (49 machine/98 process/153 filament)
- ✅ `/cloud/devices?lan_fallback=1` → `{"ok":true,"devices":[{id: fa65ef..., name: "Anycubic Kobra S1 (LAN)", online: true}]}`
- ✅ Bridge `/lan/status?ip=<LAN_IP>` → telemetria LAN completa (temps, features, ACE, rtspUrl)

## Fluxo de utilização

1. **Bridge ativo**: `powershell -File scripts/start-bridge.ps1` (ou já em execução, porta 37645)
2. Abrir OrcaSlicer → aprovar pedido de permissão (1× por arranque, via ENTER)
3. **Prepare**: escolher impressora "Anycubic Kobra S1" + perfil PLA → fatiar
4. **Device**: a impressora aparece como "Anycubic Kobra S1 (LAN)" via agent → enviar impressão
5. O bridge encaminha o comando para a impressora por MQTT local (9883)

## Nota sobre LAN Mode vs Cloud

|                 | Cloud Mode          | LAN Mode (atual)                     |
| --------------- | ------------------- | ------------------------------------ |
| Descoberta Orca | getPrinters (conta) | **fallback lan_fallback=1**          |
| Telemetria      | MQTT cloud 8883     | MQTT local 9883 (mais rápido)        |
| Camera          | Agora WebRTC        | HTTP-FLV http://IP:18088/flv         |
| Print start     | sendOrder cloud     | MQTT `print/start` local             |
| Conta Anycubic  | Necessária          | **Despareada** (re-pair para voltar) |

---

# Diagnóstico OrcaSlicer "impressora não conecta" (2026-09-05)

## Causa raiz

O `OrcaSlicer.conf` tinha um binding stale em `local_machines`:

```
"192.168.3.111": { access_code: "88888888", printer_agent_id: "orca", ... }
```

Esse binding era uma tentativa antiga de LAN direta com o **agent default "orca"**
(protocolo Bambu: MQTT bblp@8883 + access_code). A impressora nunca respondeu por esse
caminho (IP errado/protocolo errado) — por isso "não responde" ao clicar conectar.

## Correções

1. `local_machines` reescrito para o device real via **nosso agent**:
   - Em modo cloud: `"<PRINTER_ID>": { access_code: "cloud-<PRINTER_ID>", printer_agent_id: "anycubic-cloud" }`
   - Em modo LAN: `"fa65ef...": { dev_ip: "127.0.0.1", access_code: "anycubic-cloud-local-proxy", printer_agent_id: "anycubic-cloud" }`
     (`scripts` de patch no histórico; backup em `OrcaSlicer.conf.bak2`)
2. `user_last_selected_machine` atualizado para o dev_id correspondente.
3. Plugin: `_LEGACY_DEVICE_IDS` com aliasing (<PRINTER_ID>/192.168.3.x → device atual) para
   bindings antigos nunca mais falharem em silêncio.
4. Plugin: `_selected_machine` restaurado no arranque do agent (via `_devices()`).

## Comportamento do Orca (importante)

- O Orca arranca sempre com o agent **"orca"** (Bambu-protocol default) e só faz
  `switch_printer_agent → anycubic-cloud` quando o **utilizador seleciona um device
  do nosso agent no tab Device** (ou abre o dashboard do plugin).
- A cloud estava intermitente durante o diagnóstico (LAN Mode ligado/desligado):
  - LAN ON → `getPrinters` devolve vazio (impressora despareada)
  - LAN OFF / re-paired → `getPrinters` devolve a Kobra S1 online
- Pipeline verificado ponta-a-ponta com o Python do próprio Orca:
  `/cloud/devices` → `[{id: <PRINTER_ID>, key: 94badc..., online: true}]` ✅

## Passo final do utilizador

1. Abrir o OrcaSlicer → tab **Device**
2. Na lista de devices (agent anycubic-cloud), selecionar **Kobra S1** → Connect
3. O Orca faz `switch_printer_agent → anycubic-cloud` e o device fica conectado
   (a partir daí o slice envia diretamente: Prepare → Slice plate → Print)

Se o device aparecer offline: confirmar que o bridge está ativo
(`scripts/start-bridge.ps1`) e que a impressora está visível na conta Anycubic
(app do telemóvel / web).

