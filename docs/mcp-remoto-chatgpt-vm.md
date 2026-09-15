# MCP remoto — ChatGPT online a partir de uma VM (STANDBY)

> Status: **em standby** (2026-09-12). Decisão pendente: opção A vs B.
> Requisito prévio: o servidor atual (`dist/server.mjs`) é MCP **stdio** — o
> ChatGPT online só fala **Streamable HTTP** por HTTPS.

---

## Objetivo

Rodar o serviço MCP numa VM e ligá-lo a chatbots noutras máquinas, incluindo o
**ChatGPT online** (web/app/API), sem depender da versão instalada no PC.

## Contexto técnico (porque é preciso um passo extra)

| Item                                   | Valor                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------- |
| Transporte atual                       | `stdio` (processo local)                                                  |
| Transporte exigido pelo ChatGPT online | Streamable HTTP + HTTPS                                                   |
| Alcance                                | ChatGPT é produto hosted → precisa de endpoint acessível pela internet    |
| Ferramentas existentes                 | `npx mcp-remote` (bridge stdio→HTTP) · `supergateway` (adapter)           |
| Exposição REST                         | `scripts/rest-bridge.mjs` já existe (REST token-gated, mas **não é MCP**) |

Diagrama:

```text
ChatGPT online (web/app/API)
        │  HTTPS + OAuth 2.1 / API key
        ▼
Túnel/Ingress (Cloudflare Tunnel · Tailscale Funnel · ngrok)
        ▼
Adapter MCP Streamable HTTP (na VM)
        ▼
dist/server.mjs (MCP stdio — código atual)
        ▼
Slicer Next · Impressora LAN · Cloud Anycubic
```

## Caminhos do ChatGPT online (resumo)

| Caminho                    | Superfície                                                 | Auth                 | Nota                                         |
| -------------------------- | ---------------------------------------------------------- | -------------------- | -------------------------------------------- |
| Connectors                 | Chat humano (web/app)                                      | OAuth 2.1 ou API key | Sem Developer Mode → só `search`/`fetch`     |
| Developer Mode             | Chat humano, todas as tools                                | idem                 | Necessário p/ controlar a impressora no chat |
| Responses API / Agents SDK | Programático (`type:"mcp"`, `server_url`, `authorization`) | Bearer token         | Ideal p/ bot próprio em qualquer máquina     |
| Ponte stdio→HTTP           | `mcp-remote` / `supergateway`                              | Local → túnel        | Parastdio sem reescrita                      |

---

## OPÇÃO A — Adapter MCP Streamable HTTP no projeto

**Descrição:** implementar um `scripts/mcp-http-bridge.mjs` que reutiliza as 79
tools existentes e as serve como MCP Streamable HTTP (endpoint `/mcp`), com:

- Filtro de ferramentas por classe de segurança:
  - expor online apenas o **subconjunto read-only** (estado, câmara snapshot,
    account_devices, printer_read_all, etc.);
  - manter as tools de escrita (print, temp, motion, ACE) **fora** do endpoint
    público ou com `require_approval: "always"`.
- OAuth 2.1 (`/.well-known/oauth-authorization-server`) OU API key Bearer.
- Execução na VM junto do `dist/server.mjs`.

**Prós**

- Controle total do leque exposto (segurança por pressão).
- Sem dependências externas além do pacote MCP HTTP do SDK.
- Uma superfície única MCP nativa p/ ChatGPT, Claude, Copilot, agents.

**Contras**

- Trabalho de implementação (novo módulo + testes).
- Responsabilidade de manutenção do bridge.

**Esforço estimado:** médio (meio dia com testes).

---

## OPÇÃO B — Guia de deploy VM + túnel, usando `mcp-remote` (sem tocar no código)

**Descrição:** não alterar o código. Documentar passo a passo:

1. Instalar `dist/server.mjs` na VM.
2. Embrulhar com bridge externo:
   ```bash
   npx mcp-remote http://localhost:8766/mcp
   ```
   ou `supergateway` (auth na frente do HTTP).
3. Expor via túnel HTTPS sem IP público:
   - **Cloudflare Tunnel** (`cloudflared tunnel --url ...`) — gratuito,
     recomendado, sem abrir portas.
   - **Tailscale Funnel** (se a VM e as máquinas estiverem na mesma tailnet).
   - ngrok (alternativa rápida).
4. Registar no ChatGPT: `Settings → Connectors → Advanced → Developer mode`
   → criar connector com URL, Auth (API key suficiente p/ uso pessoal) → confiar.
5. Alternativa programática: Responses API com
   `tools: [{type:"mcp", server_url, authorization:"Bearer ..."}]`.

**Prós**

- Zero alterações de código (entrega imediata).
- Ferramentas maduras e mantidas pela comunidade.

**Contras**

- Todo o leque de tools fica exposto (menos controlo granular) — mitigar com
  API key forte + túnel restrito + confiança manual.
- Uma camada extra de processo (bridge) a manter/atualizar.

**Esforço estimado:** baixo (guia + validação).

---

## Requisitos comuns a ambas as opções

1. **Ligação aos alvos**: Slicer Next instalado na VM; impressora na mesma
   LAN/VPN da VM (Tailscale resolve); cloud inalterado.
2. **Auth obrigatória**: MCP spec exige OAuth 2.1 resource server
   (`/.well-known/oauth-authorization-server` + Bearer). Para uso pessoal, uma
   API key serve de arranque; não expor long-lived tokens a utilizadores.
3. **Confirm de escrita**: manter `confirm:true` + `confirm_word:"EXECUTE"`
   nas tools de escrita, ou `require_approval:"always"` na API.

## ⚠️ Segurança (crítico neste projeto)

O servidor controla uma impressora (aquece, move eixos, imprime cloud/LAN).
Expor à internet sem mitigação é perigoso — o ChatGPT online é um alvo de
prompt injection. Regras:

- Expor **só o subconjunto read-only** online.
- Tools de escrita fora do connector público.
- Token Bearer por sessão (mint curto), nunca long-lived.
- Documentar no repo o surface exposto (allowlist por classe).

## Decisão pendente

- [ ] ( ) Opção A — adapter MCP próprio no projeto
- [ ] ( ) Opção B — guia deploy VM + `mcp-remote`/túnel
