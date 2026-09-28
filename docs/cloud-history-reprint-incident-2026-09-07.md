# Incidente: repetição de ficheiro cloud histórico falhou com 10115

Data: 2026-09-07

> **Aplicabilidade:** este incidente documenta o contrato de impressão cloud da
> **linha Anycubic FDM em geral** (qualquer modelo Kobra 2/3/4/X/S1 com ACE),
> reproduzido numa unidade de teste Kobra S1 com firmware <FW_VERSION>. As lições —
> `order_id=1`, `filetype=0`, `slice_param` completo, `ams_info` mapeado,
> verificação pós-envio — aplicam-se a todos os equipamentos da família; os IDs
> exatos foram **validados ao vivo em 2026-09-11** (ver
> `live-validated-order1-2026-09-11.md`).

## Resumo

O MCP tentou repetir um G-code 3MF que já tinha sido impresso com sucesso, mas
construiu a ordem como se o ficheiro fosse local. A API aceitou o pedido e criou
uma tarefa, porém a impressora (unidade de teste Kobra S1) rejeitou-a imediatamente
com o erro `10115` (`The printer cannot parse the file`). Não houve aquecimento nem
movimento.

A repetição iniciada depois pela aplicação móvel funcionou e fornece um controlo
positivo do contrato correto. Até a implementação ser corrigida e validada no
hardware, `account_print` não deve ser usado para repetir ficheiros históricos da
Anycubic Cloud.

## Artefacto validado

O ficheiro correto não foi refatiado:

| Campo                     | Valor                                                          |
| ------------------------- | -------------------------------------------------------------- |
| Nome                      | `0901-1452-OpenSCAD Model_plate(02)_PLA_0.2_7h2m14s.gcode.3mf` |
| Tarefa original concluída | `118042672`                                                    |
| Cloud file/model id       | `87816937`                                                     |
| G-code id                 | `117442081`                                                    |
| Sliced MD5                | `15efdeac5924b17de30b730e86d7d58d`                             |
| Dimensões                 | `200 x 250 x 60.2 mm`                                          |
| Camadas                   | `301`                                                          |
| Tempo estimado            | `25334 s` (`7h 2m 14s`)                                        |
| Filamento estimado        | `200.85 g`                                                     |

## Evidência comparativa

### Pedido criado pelo MCP (falhou)

| Campo                          | Valor observado                         |
| ------------------------------ | --------------------------------------- |
| Tarefa                         | `119720568`                             |
| Origem                         | `pcf`                                   |
| Duração até falhar             | aproximadamente 1 segundo               |
| `model`                        | `0`                                     |
| `gcode_id` criado              | `119124838` (não é o G-code solicitado) |
| `slice_param` / `slice_result` | `null` / `null`                         |
| Imagem, dimensões e camadas    | vazias / zero                           |
| Resultado                      | `print_status=3`, `reason=10115`        |

### Pedido criado pela aplicação móvel (aceite)

| Campo                          | Valor observado                             |
| ------------------------------ | ------------------------------------------- |
| Tarefa                         | `119721474`                                 |
| Origem                         | `android`                                   |
| `model`                        | `87816937`                                  |
| `gcode_id`                     | `117442081`                                 |
| `slice_param` / `slice_result` | completos                                   |
| Imagem, dimensões e camadas    | preservadas; 301 camadas                    |
| Estado inicial observado       | `print_status=13` (sequência de preparação) |

O contraste `model=0` + metadados de slice ausentes é suficiente para classificar
a tarefa do MCP como malformada, mesmo antes de receber o erro 10115.

## Causa raiz no MCP

A função `sendStartPrint` em `dist/server.mjs` mistura dois contratos diferentes:

1. usar `order_id=1` (int, `AnycubicOrderID.START_PRINT` do reference
   Nino6689/anycubic-cloud-api). A hipótese inicial do `order_id="1240"` foi
   **provada errada ao vivo em 2026-09-11**: o servidor responde “Operation
   successful” para qualquer id, mas com 1240 nunca criava tarefa; com 1 criou
   (tarefas 0 e 0, esta última chegou a `printing` na
   impressora física). No MCP o id (1) era o certo desde o início — o que
   faltava era o shape do `data` (filetype 0 + `slice_param` completo +
   `ams_info` mapeado);
2. envia `filetype=1`, que significa ficheiro local na impressora, embora tenha
   recebido um `file_id` da Anycubic Cloud;
3. envia `filepath=""`, incompatível com `filetype=1`;
4. define `ams_info` apenas como `{use_ams:true}`, sem o mapeamento de materiais
   para os slots do ACE;
5. não resolve o G-code cloud antes do envio por
   `/work/gcode/infoFdm?id=<gcode_id>`;
6. interpreta a aceitação HTTP como sucesso da impressão, sem verificar a tarefa
   criada e a resposta do equipamento.

O servidor respondeu com sucesso porque validou apenas a receção da ordem. A
impressora recebeu uma referência de ficheiro local vazia e não conseguiu
resolver/parsing do 3MF.

## Contrato a implementar

O fluxo cloud deve ser separado explicitamente do fluxo local:

1. consultar `/work/gcode/info?id=<gcode_id>` e confirmar `status=2`, tamanho,
   `model`, `slice_param`, `slice_result` e hash;
2. consultar `/work/gcode/infoFdm?id=<gcode_id>` (o `id` é o G-code id, não o id
   da tarefa) e obter o cloud file id/material list resolvido;
3. construir um pedido cloud com `filetype=0`, `file_id=<cloud file id>` e os
   campos do `AnycubicStartPrintRequestCloud`;
4. enviar `order_id=1` (int), `printer_id`, `project_id=0`, `data` (com
   `filetype=0`, `file_id`, `slice_param` completo), `ams_info` e
   `settings` no formato esperado — **sem** `msgid`/`timestamp` ao nível do
   topo do corpo (o `msgid` só volta na resposta);
5. exigir um mapeamento ACE explícito. `paint_index` não deve ser assumido como
   slot físico; o slot tem de ser escolhido/confirmado e convertido para
   `ams_index`;
6. depois da aceitação, consultar a nova tarefa e só devolver sucesso quando
   `model`, `gcode_id`, `slice_param` e `slice_result` coincidirem com o ficheiro
   solicitado e a impressora entrar numa fase ativa;
7. se a tarefa terminar com erro, devolver o `reason_id` do equipamento e nunca
   repetir automaticamente a ordem.

Para ficheiro local, deve ser usada uma operação separada com `filetype=1`,
`filename` e `filepath` válidos, depois de confirmar que o ficheiro existe na
lista local da impressora.

## Guardas obrigatórias

- Não considerar `sendOrder` bem-sucedido como prova de início da impressão.
- Rejeitar antes do envio combinações como `filetype=1` + `filepath` vazio.
- Rejeitar `use_ams=true` sem `ams_box_mapping`.
- Não criar um novo `gcode_id` ao repetir um artefacto histórico já processado.
- Bloquear uma segunda tentativa enquanto a primeira não tiver estado terminal
  confirmado, evitando trabalhos duplicados.
- Não expor `printer.key`, JWT, XX-Token ou credenciais MQTT em logs/erros.

## Testes necessários antes de reativar o fluxo

1. Teste unitário golden do corpo exato para cloud (`filetype=0`, ordem 1 int,
   metadados e mapeamento ACE).
2. Teste unitário que rejeite o corpo local incompleto observado neste incidente.
3. Teste de integração read-only para resolver `gcode_id -> cloud file id` e
   comparar hash, dimensões e camadas.
4. Teste ao vivo supervisionado com um ficheiro pequeno já impresso com sucesso.
5. Verificação pós-envio da tarefa cloud e do estado MQTT antes de reportar
   `ok=true` ao cliente MCP.

## Estado da impressão iniciada pelo utilizador

Após o incidente, o utilizador iniciou o ficheiro correto pela aplicação móvel.
A telemetria cloud confirmou a tarefa `119721474` com os ids e metadados esperados.
Na leitura inicial estavam ativos `ai_detect=1`, AI global `status=3` com os dois
canais configurados, secagem a `45 C`, auto-leveling, flow calibration e vibration
compensation. Esta tarefa não foi iniciada pelo MCP.
