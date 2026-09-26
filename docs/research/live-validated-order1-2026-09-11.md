# Cloud print start — live-validated contract (2026-09-11)

Este documento descreve o contrato de **início de impressão cloud** da linha
Anycubic FDM, validado ao vivo com uma unidade de teste física (Kobra S1,
firmware <FW_VERSION>). É agnóstico ao modelo — aplica-se a qualquer Kobra 2/3/4/X/S1
com ACE; os IDs de máquina/ordem variam por modelo.

## O fix (causa raiz)

`START_PRINT` é o **order_id 1 (inteiro)**, não 1240.

- **Reference (validado em hardware):** `AnycubicOrderID.START_PRINT = 1`
  (IntEnum) em `src/anycubic_cloud_api/const/enums.py` do
  Nino6689/anycubic-cloud-api.
- **Prova empírica:** `order_id=1240` (todas as variantes testadas: ref-exact,
  byte-exact, AMS mapping, full slice_param, MQTT) → o servidor responde
  "Operation successful" + msgid mas **nunca cria tarefa**. `order_id=1` →
  `data.task_id` na resposta e a tarefa é criada, a impressora pré-aquece e
  imprime.
- A hipótese "1240" no incidente era anterior ao reference. O MCP usava o id
  certo (1) mas o data errado (filetype 1 + filepath vazio + sem slice_param) → 10115.

## Corpo de pedido que funciona (order 1)

`POST /work/operation/sendOrder`:

```json
{
  "printer_id": <int>,
  "order_id": 1,
  "project_id": 0,
  "data": {
    "filetype": 0,
    "file_key": "",
    "file_name": "<nome sem extensão>",
    "file_id": <cloud file id>,
    "hollow_param": null,
    "is_delete_file": 0,
    "matrix": "",
    "project_type": 1,
    "punching_param": null,
    "slice_param": { ... completo de /work/gcode/infoFdm },
    "slice_size": null,
    "template_id": 0,
    "task_settings": { "ai_detect": 1, "camera_timelapse": 0 }
  },
  "ams_info": {
    "ams_box_mapping": [{ "ams_color": [r,g,b], "ams_index": <slot>,
      "filament_used": <g>, "material_type": "PLA",
      "paint_color": [r,g,b], "paint_index": <idx> }],
    "use_ams": true
  },
  "settings": null
}
```

### Pontos críticos (cada um errado = silêncio ou rejeição)

- **`order_id` deve ser o INTEGER 1** (`AnycubicOrderID.START_PRINT`). 1240
  aceita com "Operation successful" e nunca cria tarefa. O `data.task_id` na
  resposta (presente = sucesso) é o discriminador.
- **`slice_param` completo é obrigatório** — null → nunca arranca (silêncio).
  A app móvel preserva-o; o corpo malformado do incidente não o tinha.
- **`file_key` vazio** (não o cloud file id).
- **`data` leva `file_id`**, não `gcode_id`.
- **`ams_info`** mapeado quando a impressora tem ACE (guard `no_map_for_ace` no
  reference): `ams_box_mapping` + `use_ams`. `paint_index` **não** é o slot
  físico — o slot é escolhido/confirmado e convertido para `ams_index`
  (ex.: cor no `printer.color[]`).
- **Sem `msgid`/`timestamp` ao nível do topo** do corpo (o `msgid` só volta na
  resposta).
- `settings: null`, `project_id: 0`.

## Sequência validada ao vivo

1. Esperar a impressora livre (`is_printing` falso / `ready_status`).
2. `sendOrder` order 1 → resposta com `data.task_id`.
3. Tarefa criada: metadados corretos (`model` = file_id, `gcode_id`, slice) —
   **verificar com `/v2/project/info?id=<task_id>`**.
4. Device: `preheating` (nozzle sobe para target, bed sobe) → `fod`/auto-level →
   `printing` (curr_layer a subir, `supplies_usage` a crescer).
5. Sucesso = `state:"finished"`, `print_status` 2, `progress` 100.

### Erros conhecidos e como escapar

| Sintoma                                                             | Causa                              | Ação                                                                                                |
| ------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| "Operation successful" sem `task_id`                                | order_id errado (ex. 1240)         | usar 1 int                                                                                          |
| Task com `print_status:3`, reason 10101 "Print task already exists" | tarefa residual na impressora      | `STOP_PRINT` (order 4, `project_id` = tarefa antiga, `data.taskid` = id antigo) → limpar → reenviar |
| 10115 "cannot parse the file"                                       | filetype 1 / ficheiro local errado | filetype 0 + cloud file_id + slice_param                                                            |
| 10116 "Abnormal slice file"                                         | slice antigo truncado              | novo slice via app (`slice_via_app`) antes do envio                                                 |
| Rate limit `请求过于频繁`                                           | login em rajada                    | espaçar >10 s                                                                                       |

## Implementação

- `scripts/printer-command-bus.mjs` — `buildCloudStartPrintBody` (order 1,
  slice_param, sem msgid), `resolveCloudGcode`, `verifyStartedTask`,
  `cloudPrintStart`.
- `scripts/anycubic-cloud.mjs` — `ORDER.START_PRINT = 1`,
  `sendOrder` (int para ordens de projeto, string para printer-level).
- Tests: `tests/printer-command-bus.test.mjs` (62/62 no total).
- Docs parceiras: `docs/printer-command-bus.md`, `docs/printer-property-map.md`.
