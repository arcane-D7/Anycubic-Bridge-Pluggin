# AGENTS.md — Regras para agentes (Copilot / Codex / Claude / qualquer IA)

Este repositório é **um plugin MCP local agnóstico**. Foi sanitizado para **não conter
nenhum dado desta máquina nem da conta do autor** e o histórico do GitHub foi limpo.
Qualquer edição futura **deve** preservar esse agnosticismo.

> Regra de ouro: se um valor varia de máquina para máquina ou de conta para conta,
> **não pode estar hardcoded no repo** — tem de vir de uma variável de ambiente
> ou de um placeholder. Se um valor pertence ao teu ambiente, **não comites**.

---

## 1. Proibições absolutas (breaking changes)

NUNCA escrever, gerar ou commitar:

- **Paths de utilizador/máquina**: `C:\Users\<nome>`, `/home/<nome>`, `%USERPROFILE%`, o
  teu username real, o teu hostname, `C:\Program Files\...` hardcoded quando derivável.
- **IPs da LAN local**: `192.168.x.x`, `10.x.x.x`, `172.16-31.x.x` da tua rede — usar
  `<LAN_IP>` em docs ou env var em código.
- **IDs de conta cloud**: printer id, task id, gcode id, file id, user id reais
  (e.g. `688972`, `120622460`, `834765`) — ver secção 6 (fixtures).
- **Device keys / access codes / tokens / JWT** reais — sempre via env var,
  nunca commitados. `.lan-creds.json`, `.probe-*.json`, `.sweep-events.json`,
  `.control-events.json` estão gitignored — nunca os force-add.
- **Firmware/versões reais observadas** como se fossem defaults de protocolo.
- **Screenshots/captures** com dados reais fora de `docs/evidence/` (e mesmo aí,
  redigidos). `poc-output/` está gitignored por isso.

## 2. Paths — como fazer certo

| Precisas de…                     | Usa                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Raiz do repo (em scripts `.mjs`) | `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")`                                                        |
| Raiz do repo (em scripts `.ps1`) | `Split-Path -Parent $PSScriptRoot` (se o script está em `scripts/`)                                                       |
| Raiz do repo (`.mcp.json`, UI)   | `${workspaceFolder}` — **mas** nunca o ponhas no caminho real de execução de um entry `node`; usa `scripts/mcp-entry.mjs` |
| AppData do utilizador            | `process.env.APPDATA` (Windows) / `${env:APPDATA}` — **nunca** o caminho expandido                                        |
| Config local da máquina          | variável de ambiente (ver secção 4) ou ficheiro gitignored                                                                |

NUNCA referencies `"C:\Users\..."`, `"C:\\Users\\..."` (escapes JS) nem `"/Users/..."` —
mesmo em comentários ou exemplos. Em docs, usa `<USER_HOME>` / `<APPDATA>`.

## 3. Placeholders de documentação

Em **markdown** podes usar placeholders legíveis (texto livre):

`<REPO_ROOT>` · `<APPDATA>` · `<EXPORT_ROOT>` · `<USER_HOME>` · `<DEVICE_KEY>` ·
`<PRINTER_ID>` · `<MACHINE_TYPE>` · `<ACE_MODEL_ID>` · `<LAN_IP>` · `<FW_VERSION>` ·
`<MD5>` · `<TASK_ID>`

Em **JSON** (que tem de continuar a ser parseável) nunca uses `<X>` — usa valores
sintéticos: números → `0`, strings → `""` ou `"redacted"`, IPs → `"127.0.0.1"`.

## 4. Configuração por variáveis de ambiente (agnóstico)

Tudo o que varia por máquina/conta entra por env vars com prefixo `ANYCUBIC_`:

`ANYCUBIC_ACCESS_CODE` · `ANYCUBIC_PRINTER_IPS` · `ANYCUBIC_CLOUD_TOKEN` ·
`ANYCUBIC_CLOUD_REGION` · `ANYCUBIC_SLICER_EXE` · `ANYCUBIC_CONTROL_OUTPUT_ROOT` ·
`ANYCUBIC_FW_VERSION` · `ANYCUBIC_PRINTER_ID` · `CAD_AI_API_KEY` · `CAD_AI_BASE_URL` · `CAD_AI_MODEL`

Regra: se precisaste de um valor só teu para testar, lê-o de uma env var com
default seguro (`process.env.X ?? defaultAgnostico`), nunca de um literal.

## 5. `scripts/sanitize-repo.mjs` — corre antes de cada push

Existe um sanitizador reutilizável. Roda-o antes de qualquer push:

```sh
node scripts/sanitize-repo.mjs --dry-run   # mostra o que apanharia
node scripts/sanitize-repo.mjs --apply     # aplica
```

- **NUNCA** edites `scripts/sanitize-repo.mjs` para reintroduzir um teu path/ID no
  teu código e depois correr `--apply` à espera que ele limpe — o próprio ficheiro
  é auto-excluído (SKIP_FILES) e guarda os literais só para os remover.
- `scripts/redact-evidence-json.mjs` mantém `docs/evidence/*.json` JSON-válido
  (redige `<PRINTER_ID>` → `0`, etc.) — corre-o quando tocas em evidências.

## 6. Fixtures de testes (o que é permitido)

`tests/` está em `SKIP_DIRS` do sanitizador de propósito. Valores como
`688972`, `192.168.3.110`, `94badc6d1b2fd4ce38371270fc17d172` aparecem aí como
**fixtures fictícias deliberadas** — são obviamente falsos e necessários aos testes.
Não há problema em mantê-los. Mas **nunca** copies esses valores para código de
produção ou docs como se fossem reais.

## 7. Entry point MCP (como arrancar o servidor)

O erro clássico: `"args": ["${workspaceFolder}/dist/server.mjs"]` — **não** funciona
em todos os clientes MCP (o token fica literal → `MODULE_NOT_FOUND`).

Usa sempre:

```jsonc
{
  "mcpServers": {
    "anycubic-slicer-next": {
      "command": "node",
      "args": ["${workspaceFolder}/scripts/mcp-entry.mjs"],
      "cwd": "${workspaceFolder}",
    },
  },
}
```

`scripts/mcp-entry.mjs` resolve `dist/server.mjs` relativo a si próprio e
auto-builda se faltar. Nunca ponhas `dist/` em paths de execução do cliente.

## 8. Health gate (obrigatório antes de commit de código)

```sh
node scripts/build.mjs && node --test "tests/*.test.mjs" && node scripts/smoke.mjs
```

- Build **OK** → `dist/server.mjs` regenerado a partir de `vendor/server.mjs`.
- Testes: **188 pass** (fixtures se mantêm — não asserts de valores reais).
- Smoke: **92 tools** responde.

## 9. Mensagens de commit

Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`).
Se algo toca em dados pessoais → `chore(security):`. Nunca incluas dados sensíveis
no corpo do commit.
