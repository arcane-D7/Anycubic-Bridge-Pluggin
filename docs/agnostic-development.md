# Desenvolvimento agnóstico à máquina — guia prático

Este guia complementa o `AGENTS.md` com o detalhe necessário para manter o
repositório **100% agnóstico** (sem dados desta máquina nem da conta) em qualquer
desenvolvimento futuro.

---

## 1. Porque é que isto importa

Este repo foi alvo de uma limpeza completa de segurança (commit `0ccafd4` +
histórico reescrito em `ad7bee1`). Removemos:

- paths do utilizador (`C:\Users\mafsc\...`, `%APPDATA%` real)
- device key / printer id / machine type / ACE model / firmware reais
- IP da LAN da rede doméstica
- ids de conta cloud (user id, task ids, gcode id, file ids)
- captures e evidências com dados reais

O objetivo é que **qualquer pessoa** possa clonar e correr o plugin usando **as suas
próprias** credenciais/impressora, sem herdar as nossas, e sem expor as nossas.

---

## 2. Convenção de placeholders

### Em markdown (texto livre)

| Placeholder      | Significado                     |
| ---------------- | ------------------------------- |
| `<REPO_ROOT>`    | raiz do repositório clonado     |
| `<APPDATA>`      | `%APPDATA%` (config do slicer)  |
| `<EXPORT_ROOT>`  | diretório de export configurado |
| `<USER_HOME>`    | home do utilizador atual        |
| `<DEVICE_KEY>`   | device key da impressora        |
| `<PRINTER_ID>`   | id cloud da impressora          |
| `<MACHINE_TYPE>` | machine type id (ex `20025`)    |
| `<ACE_MODEL_ID>` | ACE box model id (ex `40002`)   |
| `<LAN_IP>`       | IP da impressora na LAN         |
| `<FW_VERSION>`   | firmware observado              |
| `<MD5>`          | hash md5                        |
| `<TASK_ID>`      | task id cloud de uma impressão  |

### Em JSON (tem de continuar parseável)

| Valor real                          | Valor sintético      |
| ----------------------------------- | -------------------- |
| id numérico (`688972`, `120622460`) | `0`                  |
| string de chave/device key          | `""` ou `"redacted"` |
| IP real                             | `"127.0.0.1"`        |
| md5                                 | `"md5-redacted"`     |

### Em código

Código **nunca** deve conter placeholders — deve ler de env vars com defaults
agnósticos (ver secção 4). Placeholders em código só são aceitáveis em
`local-scripts/**` (debug descartado e ignorado pelo Git).

---

## 3. Paths — resolução correta

### Em `.mjs` (ESM)

```js
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
```

### Em `.ps1`

```powershell
# script em scripts/ → raiz do repo
$projectDir = Split-Path -Parent $PSScriptRoot
# ou para ficheiro irmão na raiz
$serverPath = Join-Path $projectDir 'dist\server.mjs'
```

### Em `.mcp.json`

**NUNCA**: `"args": ["${workspaceFolder}/dist/server.mjs"]` — alguns clientes não
expandem o token dentro do `args` e o node tenta abrir um path literal com
`${workspaceFolder}`.

**TAMBÉM NUNCA**: `"args": ["${workspaceFolder}/scripts/mcp-entry.mjs"]` — o
mesmo problema: nem todos expandem o token dentro de `args`.

**SEMPRE**:

```jsonc
"args": ["scripts/mcp-entry.mjs"],
"cwd": "${workspaceFolder}"
```

Os argumentos do node são um **caminho relativo** resolvido a partir do `cwd`
(que o cliente expande) — `scripts/mcp-entry.mjs` resolve-se de forma fiável.
`scripts/mcp-entry.mjs`:

1. resolve `dist/server.mjs` relativo a si próprio (independente do cwd);
2. auto-builda a partir de `vendor/server.mjs` se `dist/` não existir (fresh clone);
3. devolve ao servidor real mantendo o transporte stdio intacto.

### Paths do sistema (Windows)

- Slicer: `C:\Program Files\AnycubicSlicerNext\...` — o executável é detetado por
  `discoverSlicerExecutable()` em `scripts/slicer-cli.mjs`, com override por
  `ANYCUBIC_SLICER_EXE`. **Nunca** hardcodes o teu path de instalação.
- AppData: usa `process.env.APPDATA` — a função `findSlicerJwt()` em
  `scripts/anycubic-cloud.mjs` já expande `%APPDATA%`.

---

## 4. Variáveis de ambiente (fonte única de verdade por máquina)

| Variável                                              | Uso                              | Onde é lida                    |
| ----------------------------------------------------- | -------------------------------- | ------------------------------ |
| `ANYCUBIC_ACCESS_CODE`                                | access code da impressora LAN    | `.mcp.json` env                |
| `ANYCUBIC_PRINTER_IPS`                                | IP(s) da impressora              | `.mcp.json` env                |
| `ANYCUBIC_CLOUD_TOKEN`                                | JWT cloud capturado              | `.mcp.json` env                |
| `ANYCUBIC_CLOUD_REGION`                               | região cloud (`en`/`cn`)         | `.mcp.json` env                |
| `ANYCUBIC_SLICER_EXE`                                 | override do executável do slicer | `slicer-cli.mjs`               |
| `ANYCUBIC_CONTROL_OUTPUT_ROOT`                        | root de output                   | slicer CLI tools               |
| `ANYCUBIC_FW_VERSION`                                 | firmware observado (relatório)   | `printer-property-catalog.mjs` |
| `ANYCUBIC_PRINTER_ID`                                 | printer id cloud (relatório)     | `printer-property-catalog.mjs` |
| `CAD_AI_API_KEY` / `CAD_AI_BASE_URL` / `CAD_AI_MODEL` | AI text-to-CAD                   | `cad-ai-translator.mjs`        |

Padrão obrigatório:

```js
// ❌ NUNCA
const fw = "2.7.2.7";
// ✅ SEMPRE
const fw = process.env.ANYCUBIC_FW_VERSION ?? "unknown";
```

---

## 5. Sanitizador — como e quando usar

```sh
node scripts/sanitize-repo.mjs --dry-run   # modo seguro: apenas reporta
node scripts/sanitize-repo.mjs --apply     # aplica substituições
```

Cobre (data-driven, derivado de `os.homedir()`):

- paths do utilizador real → `<APPDATA>`/`<USER_HOME>`/`<REPO_ROOT>`/`<EXPORT_ROOT>`
- device key, printer id, LAN IP, firmware → placeholders
- (apenas em `docs/evidence` + `poc-output`) machine type, ACE model, md5 de 32 hex

**Avisos importantes**:

- `tests/`, `dist/`, `node_modules/` estão em `SKIP_DIRS` — fixtures ficam intactas.
- `sanitize-repo.mjs` e `redact-evidence-json.mjs` estão em `SKIP_FILES` — não os
  quebres acidentalmente ao correr `--apply` (contêm literais de lookup).
- Se adicionares um novo ficheiro de config local (gitignored), adiciona-o a
  `SKIP_FILES` para o sanitizador não o tocar.
- O sanitizador **não** repara JSON nem JS — lida com texto. `docs/evidence/*.json`
  são reparados por `scripts/redact-evidence-json.mjs` (valores sintéticos).

### Verificação manual rápida antes do push

```sh
git grep -nE "(mafsc|120622460|120800420|120029158|120799976|89894086|834765|94badc6d|192\.168\.)|C:\\\\Users" -- ":(exclude)tests" ":(exclude)scripts/sanitize-repo.mjs"
# → sem output = limpo (exit 1 do grep)
```

---

## 6. Evidências e captures

- `poc-output/` → **gitignored** (nunca forçar add; contém captures de máquina).
- `docs/evidence/*.json` → tracked mas **redigido** (placeholders em valores
  sintéticos). Se adicionares uma evidência nova, redige-a com
  `node scripts/redact-evidence-json.mjs` e valida com `JSON.parse`.
- Screenshots → `*.png` estão gitignored. Para documentar visualmente, usa
  `docs/evidence/` com descrição em texto, não a imagem crua.
- `AnycubicSlicerNextControl/` (config real do slicer) → gitignored.

---

## 7. Fixtures de testes (exceção deliberada)

Valores como `688972`, `192.168.3.110`, `94badc6d1b2fd4ce38371270fc17d172` existem
**apenas em `tests/`** como fixtures deliberadamente fictícias (testam parsing,
validação e fluxos sem dados reais). São aceitáveis **exclusivamente em testes**.

---

## 8. Identidade de cliente partilhada (NÃO é segredo)

`AC_AID`/`APP_ID` (`f9b3528877c94d5c9c5af32245db46ef`), `AC_SEC`
(`0cf75926606049a3937f56b0373b99fb`) e `AC_VER` (`V3.0.0`) são a identidade de
cliente **partilhada pela comunidade** (WaresWichall + Nino6689) e **não** são dados
do utilizador. Mantêm-se nos ficheiros — apenas não os confundas com credenciais
pessoais. O access code da **impressora** é que é pessoal (env var).

---

## 9. Health gate

Antes de qualquer commit que toque em código:

```sh
node scripts/build.mjs
node --test "tests/*.test.mjs"
node scripts/smoke.mjs
```

Resultado esperado: build ok → `dist/server.mjs` regenerado; **188/188** testes;
smoke **92 tools** responde. Se quebraste, corrige antes de commitar — um repo
agnóstico não serve se não correr.

---

## 10. Checklist de pré-push

- [ ] `node scripts/sanitize-repo.mjs --dry-run` → 0 grupos (ou apenas os esperados)
- [ ] `git grep` dos literais sensíveis → vazio fora de `tests/`
- [ ] `.mcp.json` usa `scripts/mcp-entry.mjs` (nunca `dist/server.mjs` direto)
- [ ] Health gate verde (build + 188 testes + smoke 92)
- [ ] Mensagem commit conventional, sem dados sensíveis no corpo
- [ ] `poc-output/`, `.lan-creds.json`, `.probe-*`, `.sweep-events.json`,
      `.control-events.json` NÃO staged
