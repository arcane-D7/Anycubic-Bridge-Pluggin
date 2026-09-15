# Primeira instalação — autenticação sem o Anycubic Slicer Next instalado

> Status: implementado (batch 2026-09-11b). Suite: 116 testes + smoke 79 tools.

Este guia explica como um utilizador obtém as keys de auth pela primeira vez
**sem ter o Slicer Next instalado**, usando apenas o terminal, e como tudo é
gravado de forma segura (DPAPI, utilizador atual).

## 1. Porque é que o login clássico (email/senha) não existe

O Anycubic **não permite login automático com email/senha** — o login real é
protegido por captcha/2FA. Por isso o ecossistema oficial e a comunidade
(Home Assistant, homebridge, etc.) usam **tokens**: o utilizador obtém um token
no ecossistema Anycubic (slicer, portal web ou aplicação Android) e fornece-o à
integração de uma só vez. O login é feito uma única vez; depois o token fica
guardado e utilizado automaticamente.

## 2. Caminhos para obter um token (sem Slicer Next)

| Caminho | O que é | Modo | MQTT (comandos) |
| ------- | ------- | ---- | --------------- |
| **a)** JWT do Slicer/Android noutra máquina | `access_token` (3 partes, ~344+ chars) | `pcf` | ✅ Sim |
| **b)** Token do portal web | `XX-Token` (obtido no browser) | `web` | ❌ Não (só polling HTTP) |
| **c)** Email/senha assistido por browser | O utilizador faz login no browser (portal Casdoor); o script captura o `XX-Token` | `web` | ❌ Não (só polling HTTP) |
| **d)** LAN Mode (sem conta) | já existente no bridge (18910) | — | ✅ Sim (local) |

**Regra de ouro**: se precisar de **comandos** (imprimir, pausar, temperatura,
ACE/dry, etc.), o token tem de ser **modo `pcf`** (a/b). O token web é apenas
leitura de estado.

### a) JWT do slicer (recomendado, completo)

1. Noutra máquina com Slicer Next: abra `%APPDATA%\AnycubicSlicerNext\AnycubicSlicerNext.conf` e copie o `access_token`.
2. Cole-o no terminal (ver secção 3).
3. Depois, **limpe** esse campo no ficheiro `.conf` para evitar que dois processos disputem a mesma sessão.

### b) Token do portal (leitura apenas)

1. Abra `https://cloud-universe.anycubic.com/file` e inicie sessão.
2. DevTools (F12) → Console → cole:
   ```js
   window.localStorage["XX-Token"]
   ```
3. Copie a string devolvida e cole-a no terminal (ver secção 3).

> ⚠ Limitação conhecida: tokens web são **polling-only** (sem MQTT). O bridge
> deteta automaticamente esse modo e guarda-o com `mqtt:false` para ficar
> transparente.

### c) Email/senha assistido por browser

O portal de login (`uc.makeronline.com`, Casdoor) **protege** o login com
captcha/2FA e parâmetros dinâmicos — não existe login programático por
email/senha (a comunidade WaresWichall/Nino6689 confirma). O fluxo máximo
alcançável é **browser-assisted**:

1. `node scripts/auth-login.mjs --id-flow` pede email + senha **sem eco** e
   tenta um login direto (best-effort).
2. Se o servidor exigir captcha/2FA (quase sempre), o script abre o browser no
   portal de login e mostra as instruções; o utilizador conclui o login.
3. O script captura o `XX-Token` resultante (do redirecionamento/`localStorage`),
   valida-o e grava-o DPAPI — tal como os outros caminhos.

Mesmo pipeline via tool MCP `auth_id_flow_start` (nunca pede a senha pelo
chat; apenas abre o portal e devolve instruções).

### d) LAN Mode (sem conta)

Se o objetivo for só controlar uma impressora em rede local sem conta:
`discover_printers` / `printer_status` já suportam o handshake 18910 nativo.
Consulte `docs/expansion-research.md` (fase 1).

## 3. Fluxo no terminal (`node scripts/auth-login.mjs`)

```powershell
cd <repo>
node scripts/auth-login.mjs                       # interativo (região "en")
node scripts/auth-login.mjs --region cn           # portal CN
node scripts/auth-login.mjs --id-flow             # email/senha assistido por browser
node scripts/auth-login.mjs --status              # estado atual (sem segredo)
node scripts/auth-login.mjs --clear               # apaga o token gravado
```

Durante o passo interativo:

1. O script imprime as três opções de obtenção de token.
2. Pede para **colar o token** — o input é **sem eco** (não aparece no ecrã nem
   no histórico do terminal).
3. Valida o token contra o servidor: troca por sessão
   (`/v3/public/loginWithAccessToken`), lê o perfil (`userInfo`) e deteta o modo
   (`pcf` → MQTT habilitado; `web` → apenas polling HTTP).
4. Grava DPAPI-encrypted (utilizador atual) no **mesmo** armazenamento usado
   pelo bridge: `%LOCALAPPDATA%\AnycubicSlicerNextControl\tokens\cloud-token.json`
   (ou `PLUGIN_DATA` se definido).
5. Reporta apenas metadados: `modo`, `transport`, `email`, `expira`, `caminho`.

O token em si **nunca é ecoado** — nem no ecrã, nem nos outputs dos tools.

### Através da ferramenta MCP `auth_setup`

Além do script interativo, o bridge expõe a ferramenta `auth_setup` (input
`access_token`, `region`, `timeout_ms`). Ligações humanas (ex.: um assistente a
ajudar o utilizador) podem usá-la; o token é passado diretamente e o output
não o repete.

```jsonc
// exemplo de chamada
{ "access_token": "<token do utilizador>", "region": "en" }
// resposta (sem segredo):
{ "ok": true, "stored": true, "mode": "pcf", "transport": "cloud_mqtt",
  "mqtt": true, "user_id": 42, "region": "en", "message": "..." }
```

## 4. Segurança

- O segredo é gravado com **DPAPI (CurrentUser)** via
  `scripts/token-crypt.ps1` — inacessível a outros utilizadores do sistema.
- O formato do ficheiro é idêntico ao `TokenStore` compilado em
  `dist/server.mjs` (`.json` com `{encrypted, capturedAt, sub?, email?,
  expiresAt?}`), pelo que os tools `account_token_status` / `account_login`
  continuam a funcionar sem alterações.
- Nunca cole tokens em chats/assistentes; o caminho por terminal é o
  recomendado precisamente para o segredo não circular.
- Expiração: tokens slicer duram ~90 dias. Ao expirar, refaça o passo 3.

## 5. Verificação

```powershell
node scripts/auth-login.mjs --status        # deverá mostrar stored:true + metadados
node scripts/smoke.mjs                      # 79 tools, tudo verde
node --test tests/*.test.mjs                # 116 testes
```
