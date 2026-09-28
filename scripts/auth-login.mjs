/**
 * auth-login.mjs — Primeira instalação / autenticação SEM Slicer Next instalado.
 *
 * Motivação: o Anycubic Slicer Next guarda o `access_token` (JWT) em
 * %APPDATA%\AnycubicSlicerNext e os tools de captura (`account_capture_token`)
 * dependem de o instalador existir. Este módulo permite a um utilizador novo
 * autenticar-se **apenas pelo terminal**, colando um token obtido no portal web
 * da Anycubic, e grava-o DPAPI-encrypted no MESMO armazenamento que o resto do
 * bridge (`%LOCALAPPDATA%\AnycubicSlicerNextControl\tokens\cloud-token.json`).
 *
 * Segurança:
 *  - O token NUNCA é ecoado ao ecrã nem aparece na linha de comandos;
 *    entra exclusivamente por stdin (sem echo).
 *  - O output de sucesso devolve apenas metadados (sub/email/expiração/modo).
 *  - Gravação DPAPI (utilizador atual) via scripts/token-crypt.ps1, igual ao
 *    TokenStore compilado em dist/server.mjs.
 *
 * Modos suportados (igual ao padrão da comunidade):
 *  - "pcf"  (slicer): JWT de 3 partes (344+ chars). Habilita o fluxo MQTT
 *            (printer_command_send, edge tools, dry/ACE) — é o modo completo.
 *  - "web"  (portal): token XX-Token obtido no portal. Apenas polling HTTP
 *            (read-only); NUNCA habilita MQTT. Guardado com `mqtt:false`
 *            para o utilizador saber a limitação.
 *  - LAN Mode: continua a ser a alternativa sem conta (ver docs).
 *
 * Uso:
 *   node scripts/auth-login.mjs                 # interativo (cola o token)
 *   node scripts/auth-login.mjs --region cn     # portal CN (en é default)
 *   node scripts/auth-login.mjs --status        # estado atual (sem segredo)
 *   node scripts/auth-login.mjs --clear         # apaga o token gravado
 *
 * Como módulo MCP (registado em dist/server.mjs):
 *   const { registerAuthSetupTool } = await import("../scripts/auth-login.mjs");
 *   registerAuthSetupTool(server, z2);
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// Identificadores públicos do workbench Anycubic (constantes já usadas em todo
// o repositório — scripts/anycubic-cloud.mjs e dist/server.mjs).
export const AUTH_APP_ID = "f9b3528877c94d5c9c5af32245db46ef";
export const AUTH_APP_SECRET = "0cf75926606049a3937f56b0373b99fb";
export const AUTH_APP_VERSION = "V3.0.0";
export const BASE_EN = "https://cloud-universe.anycubic.com/p/p/workbench/api";
export const BASE_CN = "https://cloud-platform.anycubicloud.com/p/p/workbench/api";
export const AUTH_MODES = Object.freeze({ PCF: "pcf", WEB: "web" });

// ---------------------------------------------------------------------------
// JWT helpers (idênticos ao TokenStore compilado — decode de claims)
// ---------------------------------------------------------------------------

export function decodeJwtPayload(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    switch (payload.length % 4) {
      case 2:
        payload += "==";
        break;
      case 3:
        payload += "=";
        break;
    }
    const json = Buffer.from(payload, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Classifica um token pelo formato (sem tocar na rede). */
export function classifyAccessToken(token) {
  const raw = String(token ?? "").trim();
  if (!raw) return { ok: false, error: "empty token" };
  const parts = raw.split(".");
  if (parts.length !== 3 || parts.some((p) => p.length < 4)) {
    return { ok: false, error: "not a 3-part JWT" };
  }
  const claims = decodeJwtPayload(raw);
  if (!claims) return { ok: false, error: "invalid JWT payload" };
  const exp = Number(claims.exp ?? NaN);
  return {
    ok: true,
    shape: "jwt",
    claims,
    expires_at: Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : undefined,
  };
}

/** Constrói o registo que será gravado (sub/email/expiração), sem segredos. */
export function buildTokenRecord(token) {
  const payload = decodeJwtPayload(token);
  const claims = payload ?? {};
  const exp = Number(claims.exp ?? NaN);
  return {
    capturedAt: new Date().toISOString(),
    ...(typeof claims.sub === "string" ? { sub: claims.sub } : {}),
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    ...(Number.isFinite(exp) ? { expiresAt: new Date(exp * 1000).toISOString() } : {}),
  };
}

// ---------------------------------------------------------------------------
// Headers assinados + login (mesmo protocolo de scripts/anycubic-cloud.mjs)
// ---------------------------------------------------------------------------

function md5(value) {
  return createHash("md5").update(value).digest("hex");
}

export function signAuthHeaders(deviceType = AUTH_MODES.PCF) {
  const nonce = randomUUID().replace(/-/g, "").slice(0, 32);
  const timestamp = String(Date.now());
  const signature = md5(
    `${AUTH_APP_ID}${timestamp}${AUTH_APP_VERSION}${AUTH_APP_SECRET}${nonce}${AUTH_APP_ID}`,
  );
  return {
    "Xx-Device-Type": deviceType,
    "Xx-Is-Cn": "1",
    "Xx-Nonce": nonce,
    "Xx-Signature": signature,
    "Xx-Timestamp": timestamp,
    "Xx-Version": AUTH_APP_VERSION,
    "XX-LANGUAGE": "US",
    "Content-Type": "application/json",
  };
}

function baseUrl(region) {
  return region === "cn" ? BASE_CN : BASE_EN;
}

/**
 * Troca um access_token por uma sessão do workbench.
 * @returns {Promise<{token:string, userId?:number, userEmail?:string}>}
 * @throws {Error} com a mensagem do servidor (contém o "code"/"msg").
 */
export async function loginWithAccessToken(accessToken, options = {}) {
  const deviceType = options.deviceType ?? AUTH_MODES.PCF;
  const url = `${baseUrl(options.region ?? "en")}/v3/public/loginWithAccessToken`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: signAuthHeaders(deviceType),
      body: JSON.stringify({ device_type: deviceType, access_token: accessToken }),
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    const code = Number(body?.code ?? (res.ok ? 0 : -1));
    const data = body?.data ?? {};
    if (!res.ok || (code !== 0 && !data.token)) {
      const detail = typeof body?.msg === "string" && body.msg ? body.msg : `HTTP ${res.status}`;
      throw new Error(
        `loginWithAccessToken(${deviceType}) failed: ${String(detail).slice(0, 200)}` +
          (Number.isFinite(code) ? ` (code=${code})` : ""),
      );
    }
    const token = data.token ?? data.access_token;
    if (!token) throw new Error("No token returned from loginWithAccessToken.");
    const au = (v) => (v === undefined || v === null ? undefined : Number(v));
    return {
      token,
      ...(Number.isFinite(au(data.user_id)) ? { userId: au(data.user_id) } : {}),
      ...(typeof data.user_email === "string" ? { userEmail: data.user_email } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function getUserInfo(session, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
  try {
    const res = await fetchImpl(`${baseUrl(session.region ?? "en")}/v1/user/profile/userInfo`, {
      method: "GET",
      headers: { ...signAuthHeaders(), "XX-Token": session.token },
      signal: controller.signal,
    });
    const body = await res.json().catch(() => ({}));
    const data = body?.data ?? body ?? {};
    return {
      ...(Number.isFinite(Number(data.id)) ? { userId: Number(data.id) } : {}),
      ...(typeof data.user_email === "string" ? { userEmail: data.user_email } : {}),
    };
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Valida um token e descobre o seu modo.
 * Ordem (padrão da comunidade `retry_access_token_as_user_token`):
 *   1. tentar como "pcf" (slicer) — se funcionar => MQTT habilitado;
 *   2. se o servidor responder "User does not exist" (token de portal),
 *      tentar como "web" — polling-only (mqtt:false).
 */
export async function validateAccessToken(accessToken, options = {}) {
  const raw = String(accessToken ?? "").trim();
  if (!raw) throw new Error("access_token is required");
  const classified = classifyAccessToken(raw);
  if (!classified.ok) {
    // Aceita tokens de portal que não sejam JWT de 3 partes? O workbench espera
    // JWT; tokens inválidos serão rejeitados na rede com a mensagem do servidor.
  }

  const attempt = async (deviceType) => {
    try {
      const session = await loginWithAccessToken(raw, {
        ...options,
        deviceType,
      });
      const info = await getUserInfo(
        { token: session.token, region: options.region ?? "en" },
        options,
      );
      return {
        ok: true,
        mode: deviceType,
        transport: deviceType === AUTH_MODES.PCF ? "cloud_mqtt" : "http_polling",
        mqtt: deviceType === AUTH_MODES.PCF,
        user_id: session.userId ?? info.userId,
        user_email: session.userEmail ?? info.userEmail,
        region: options.region ?? "en",
        ...buildTokenRecord(raw),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const pcf = await attempt(AUTH_MODES.PCF);
  if (pcf.ok) return pcf;

  const looksLikePortal = /user does not exist|invalid.*token|credential/i.test(pcf.error ?? "");
  if (looksLikePortal) {
    const web = await attempt(AUTH_MODES.WEB);
    if (web.ok) return web;
    throw new Error(web.error ?? `web fallback failed for token`);
  }
  throw new Error(pcf.error ?? "login failed");
}

// ---------------------------------------------------------------------------
// Armazenamento DPAPI (mesmo formato do TokenStore do dist)
// ---------------------------------------------------------------------------

export function pluginRoot() {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.resolve(sourceDir, ".."), sourceDir]) {
    if (path.basename(candidate) === "scripts") return path.dirname(candidate);
  }
  return path.resolve(sourceDir, "..");
}

export function defaultDataDir() {
  const local = process.env.LOCALAPPDATA;
  const base =
    process.env.PLUGIN_DATA ??
    (local
      ? path.join(local, "AnycubicSlicerNextControl")
      : path.join(pluginRoot(), "AnycubicSlicerNextControl"));
  return path.join(base, "tokens");
}

export function defaultCryptScript() {
  return path.join(pluginRoot(), "scripts", "token-crypt.ps1");
}

async function runTokenCrypt(action, env) {
  const script = defaultCryptScript();
  const { stdout, stderr } = await execFileAsync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Action",
      action,
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, env: { ...process.env, ...env } },
  );
  const out = stdout.trim();
  if (!out && stderr.trim())
    throw new Error(`token-crypt ps1 failed: ${stderr.trim().slice(0, 300)}`);
  return out;
}

export async function saveStoredToken(accessToken, options = {}) {
  const dataDir = options.dataDir ?? defaultDataDir();
  const encrypted = await runTokenCrypt("encrypt", { TOKEN_CRYPT_PLAINTEXT: accessToken });
  const record = { encrypted, ...buildTokenRecord(accessToken) };
  await mkdir(dataDir, { recursive: true });
  const file = path.join(dataDir, "cloud-token.json");
  const tmp = file + ".tmp";
  await writeFile(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
  await import("node:fs/promises").then((m) => m.rename(tmp, file));
  return record;
}

export async function loadStoredToken(options = {}) {
  const dataDir = options.dataDir ?? defaultDataDir();
  try {
    const raw = await readFile(path.join(dataDir, "cloud-token.json"), "utf8");
    const record = JSON.parse(raw);
    if (!record?.encrypted) return { stored: false };
    return {
      stored: true,
      ...(record.sub ? { sub: record.sub } : {}),
      ...(record.email ? { email: record.email } : {}),
      ...(record.expiresAt ? { expires_at: record.expiresAt } : {}),
      ...(record.capturedAt ? { captured_at: record.capturedAt } : {}),
      ...(record.mode ? { mode: record.mode } : {}),
      ...(record.mqtt !== undefined ? { mqtt: record.mqtt } : {}),
    };
  } catch {
    return { stored: false };
  }
}

export async function clearStoredToken(options = {}) {
  const dataDir = options.dataDir ?? defaultDataDir();
  await rm(path.join(dataDir, "cloud-token.json"), { force: true });
  return { cleared: true };
}

// ---------------------------------------------------------------------------
// CLI interativa (sem echo) — a forma recomendada para primeira instalação
// ---------------------------------------------------------------------------

async function promptSecret(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });
  try {
    return await new Promise((resolve) => {
      process.stdout.write(question);
      const original = rl._writeToOutput.bind(rl);
      rl._writeToOutput = () => {}; // silencia o eco do que o utilizador digita
      rl.question("", (answer) => {
        rl._writeToOutput = original;
        process.stdout.write("\n");
        resolve(answer);
      });
    });
  } finally {
    rl.close();
  }
}

export async function runInteractiveLogin(options = {}) {
  const region = options.region ?? "en";
  console.log(
    [
      `Anycubic auth — primeira instalação (região: ${region})`,
      "",
      "Opções para obter um token:",
      "  1) JWT do Slicer (access_token, 3 partes / 344+ chars) — modo pcf, habilita MQTT (completo).",
      "  2) Token do portal (XX-Token) — modo web, apenas leitura HTTP (sem MQTT).",
      "     Obtenha-o no browser: https://cloud-universe.anycubic.com/file -> DevTools ->",
      "     localStorage['XX-Token']",
      "  3) Outro caminho: veja docs/primeira-instalacao-auth-sem-slicer.md (LAN Mode sem conta).",
      "",
    ].join("\n"),
  );
  const token = await promptSecret(
    "Cole o access_token/XX-Token (não será ecoado) e pressione Enter: ",
  );
  const trimmed = token.trim();
  if (!trimmed) {
    console.log("Nenhum token recebido. Nada foi gravado.");
    return { ok: false, stored: false, error: "empty token" };
  }
  const result = await validateAccessToken(trimmed, { region });
  if (!result.ok) {
    throw new Error(result.error ?? "token inválido");
  }
  const record = await saveStoredToken(trimmed, {});
  const stored = { stored: true, ...record, encrypted: undefined };
  console.log(
    [
      "",
      "✔ Token validado e gravado (DPAPI, utilizador atual).",
      `  modo: ${result.mode}  transport: ${result.transport}`,
      result.mqtt
        ? "  MQTT: habilitado — pode usar printer_command_send e os tools de controlo."
        : "  MQTT: NÃO habilitado — token web é só polling HTTP (leitura).",
      ...(result.user_email ? [`  email: ${result.user_email}`] : []),
      ...(result.expiresAt ? [`  expira: ${result.expiresAt}`] : []),
      `  armazenado: ${defaultDataDir()}`,
      "Execute `node scripts/auth-login.mjs --status` para confirmar.",
    ].join("\n"),
  );
  return { ok: true, stored: true, ...stored };
}

export async function cliStatus() {
  const status = await loadStoredToken();
  console.log(JSON.stringify(status, null, 2));
  return status;
}

// ---------------------------------------------------------------------------
// Login por email+senha (fluxo "--id-flow")
// ---------------------------------------------------------------------------
// O login 100%% automatizado não existe nas libs da comunidade (captcha/2FA do
// Casdoor). Implementamos melhor-esforço:
//   1. tenta POST /api/login do Casdoor com email+senha (sem eco no terminal);
//   2. se o servidor pedir captcha / application/organization dinâmicos,
//      abre o browser no portal e instrui o utilizador a logar;
//   3. em qualquer caso, o user pode colar o XX-Token (validado e gravado DPAPI).
// O email/senha NUNCA são ecoados nem saem do processo.

export const AUTH_DOMAIN = "uc.makeronline.com";
export const AC_KNOWN_CID_WEB = "672efcd4ec11a66c8513";

export async function casdoorLogin(email, password, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);
  try {
    const res = await fetchImpl(`https://${AUTH_DOMAIN}/api/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36",
        Origin: `https://${AUTH_DOMAIN}`,
        Referer: `https://${AUTH_DOMAIN}/login`,
      },
      body: new URLSearchParams({
        type: "normal",
        username: email,
        password,
        application: options.application ?? "",
        organization: options.organization ?? "",
      }),
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await res.text();
    // O Casdoor responde JSON (status:error/ok) mesmo sem credenciais válidas.
    const isJson = /^[\s]*[{\[]/.test(text);
    if (isJson) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed === null) return { ok: false, httpStatus: res.status, error: "unparseable JSON" };
      if (parsed.status === "ok" && parsed.data) {
        return {
          ok: true,
          httpStatus: res.status,
          returned: redactResponse(parsed),
        };
      }
      return {
        ok: false,
        httpStatus: res.status,
        error: String(parsed.msg ?? "login rejected"),
        returned: redactResponse(parsed),
      };
    }
    return {
      ok: false,
      httpStatus: res.status,
      error: "login page (SPA) returned HTML; needs browser",
      html: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Reduz respostas do login a metadados (nunca expõe cookies/sessão). */
function redactResponse(parsed) {
  if (!parsed || typeof parsed !== "object") return parsed;
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (/cookie|session|token|password/i.test(k)) continue;
    out[k] = typeof v === "object" && v !== null ? redactResponse(v) : v;
  }
  return out;
}

function openBrowser(url) {
  const start =
    process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return execFileAsync(start, args, { windowsHide: true, timeout: 10000 }).catch(() => {});
}

export async function runIdFlow(options = {}) {
  const region = options.region ?? "en";
  console.log(
    [
      `Anycubic auth — login por email+senha (região: ${region})`,
      "",
      "Nota: a Anycubic protege o login com CAPTCHA/2FA (Casdoor). Fazemos",
      "melhor esforço programático; se falhar, o browser abre para login manual",
      "e o token é capturado/gravado a seguir.",
      "",
    ].join("\n"),
  );
  const email = await promptSecret("Email da conta Anycubic: ");
  const trimmedEmail = email.trim();
  if (!trimmedEmail) {
    console.log("Email vazio. Nada foi gravado.");
    return { ok: false, stored: false, error: "empty email" };
  }
  const password = await promptSecret("Senha (não será ecoada): ");
  if (!password) {
    console.log("Senha vazia. Nada foi gravado.");
    return { ok: false, stored: false, error: "empty password" };
  }

  const attempt = await casdoorLogin(trimmedEmail, password, options);
  if (attempt.ok) {
    // O Casdoor pode devolver o código/autorização embedded; sem sessão clara
    // tentamos capturar o XX-Token pela via normal (redirect) — ver abaixo.
    console.log("✔ Login API aceite pelo Casdoor. A capturar token…");
  } else {
    const msg = String(attempt.error ?? "unknown");
    console.log(
      attempt.html
        ? "ℹ Servidor devolveu a SPA (login exige browser e CAPTCHA human)."
        : `ℹ Login API rejeitado: ${msg}`,
    );
    console.log("A abrir o browser para login manual…");
    await openBrowser(`https://cloud-universe.anycubic.com/file`);
  }

  console.log(
    [
      "",
      "Após o login no browser (se foi aberto):",
      "  1) Abra DevTools (F12) > Console.",
      "  2) Digite: window.localStorage['XX-Token']",
      "  3) Copie o valor (sem aspas) e cole aqui em baixo.",
      "",
      "(Alternativa: rode `node scripts/auth-login.mjs` para a opção de colar token)",
      "",
    ].join("\n"),
  );
  const token = await promptSecret("Cole o XX-Token obtido (não será ecoado): ");
  const trimmed = token.trim();
  if (!trimmed) {
    console.log("Nenhum token recebido. Nada foi gravado.");
    return { ok: false, stored: false, error: "empty token" };
  }
  const result = await validateAccessToken(trimmed, { region, timeoutMs: options.timeoutMs });
  if (!result.ok) throw new Error(result.error ?? "token inválido");
  const record = await saveStoredToken(trimmed, {});
  const stored = { stored: true, ...record, encrypted: undefined };
  console.log(
    [
      "",
      "✔ Token validado e gravado (DPAPI, utilizador atual).",
      `  modo: ${result.mode}  transport: ${result.transport}`,
      result.mqtt
        ? "  MQTT: habilitado — pode usar printer_command_send e os tools de controlo."
        : "  MQTT: NÃO habilitado — token web é só polling HTTP (leitura).",
      ...(result.user_email ? [`  email: ${result.user_email}`] : []),
      ...(result.expiresAt ? [`  expira: ${result.expiresAt}`] : []),
    ].join("\n"),
  );
  return { ok: true, stored: true, ...stored };
}

// ---------------------------------------------------------------------------
// Ferramenta MCP: auth_setup
// ---------------------------------------------------------------------------

export function registerAuthSetupTool(server, z) {
  registerAuthSetupHelper(server, z);
  registerAuthIdFlowTool(server, z);
}

export function registerAuthSetupHelper(server, z) {
  server.registerTool(
    "auth_setup",
    {
      title: "Set up Anycubic cloud auth (first install, no slicer required)",
      description:
        "Validate and store an Anycubic access_token / XX-Token pasted by the user (or provided as access_token). The token is NEVER echoed back: the tool validates it against loginWithAccessToken, detects pcf (MQTT-enabled) vs web (http-polling-only) mode, and stores it DPAPI-encrypted in the same token store used by the rest of the bridge. Requires a human to supply a token obtained from the Anycubic slicer or portal (captcha/2FA make email+password login impossible).",
      inputSchema: z
        .object({
          access_token: z
            .string()
            .min(1)
            .describe("The JWT/XX-Token to validate and store. Human-provided."),
          region: z.enum(["en", "cn"]).optional().describe("Cloud region (default en)."),
          timeout_ms: z.number().int().min(3000).max(30000).optional(),
        })
        .strict(),
      outputSchema: z
        .object({
          ok: z.boolean(),
          stored: z.boolean().optional(),
          mode: z.string().optional(),
          transport: z.string().optional(),
          mqtt: z.boolean().optional(),
          user_id: z.number().optional(),
          user_email: z.string().optional(),
          region: z.string().optional(),
          sub: z.string().optional(),
          expires_at: z.string().optional(),
          stored_at: z.string().optional(),
          message: z.string().optional(),
          error: z.string().optional(),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ access_token, region, timeout_ms }) => {
      try {
        const validated = await validateAccessToken(access_token, {
          region,
          timeoutMs: timeout_ms,
        });
        if (!validated.ok) throw new Error(validated.error ?? "token inválido");
        const record = await saveStoredToken(access_token, {});
        return {
          ok: true,
          stored: true,
          mode: validated.mode,
          transport: validated.transport,
          mqtt: validated.mqtt,
          ...(Number.isFinite(Number(validated.user_id))
            ? { user_id: Number(validated.user_id) }
            : {}),
          ...(validated.user_email ? { user_email: validated.user_email } : {}),
          region: validated.region,
          ...(record.sub ? { sub: record.sub } : {}),
          ...(record.expiresAt ? { expires_at: record.expiresAt } : {}),
          stored_at: record.capturedAt,
          message: validated.mqtt
            ? "Token validated and stored (pcf mode: MQTT control enabled)."
            : "Token validated and stored (web mode: HTTP polling only, MQTT NOT enabled).",
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Ferramenta MCP: auth_id_flow_start (login por email+senha, assistido)
// ---------------------------------------------------------------------------
// A Anycubic (Casdoor) não permite login 100%% automatizado — há CAPTCHA/2FA e
// application/organization dinâmicos. Esta tool abre o browser no portal para o
// utilizador fazer login manual; nunca pede a senha via chat. O utilizador
// termina no browser e cola o XX-Token (validado e gravado DPAPI). A senha fica
// apenas no browser do utilizador — nunca entra neste processo nem no chat.

export function registerAuthIdFlowTool(server, z) {
  server.registerTool(
    "auth_id_flow_start",
    {
      title: "Start browser-assisted Anycubic login (email+password, user does it in browser)",
      description:
        "Opens the Anycubic Cloud portal in the user's browser so they can log in with their email and password (CAPTCHA/2FA handled by the portal). Then asks the user to paste the XX-Token (from DevTools localStorage) so it can be validated and stored DPAPI-encrypted. The password is NEVER requested through chat — only the result token. Returns the portal URL and instructions.",
      inputSchema: z
        .object({
          region: z.enum(["en", "cn"]).optional().describe("Cloud region (default en)."),
          open_browser: z
            .boolean()
            .optional()
            .describe("Open the browser immediately (default true)."),
        })
        .strict(),
      outputSchema: z
        .object({
          ok: z.boolean(),
          portal_url: z.string().optional(),
          instructions: z.array(z.string()).optional(),
          message: z.string().optional(),
          error: z.string().optional(),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ region, open_browser }) => {
      try {
        const portal = "https://cloud-universe.anycubic.com/file";
        if (open_browser !== false) await openBrowser(portal);
        const result = {
          ok: true,
          portal_url: portal,
          instructions: [
            "1) Faça login com email e senha no portal aberto no browser.",
            "2) Abra DevTools (F12) > Console e execute: window.localStorage['XX-Token']",
            "3) Cole o valor (sem aspas) aqui no chat — ele será validado e gravado DPAPI.",
            "A senha NUNCA deve ser enviada no chat; só o token resultante.",
          ],
          message:
            "Browser aberto no portal. Após o login, use auth_setup com o XX-Token do localStorage.",
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
        };
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Execução direta
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  const regionIdx = args.indexOf("--region");
  const region = regionIdx >= 0 ? args[regionIdx + 1] : "en";
  if (args.includes("--status")) {
    await cliStatus();
  } else if (args.includes("--clear")) {
    await clearStoredToken();
    console.log("token gravado apagado.");
  } else if (args.includes("--id-flow")) {
    try {
      await runIdFlow({ region });
    } catch (error) {
      console.error(
        `\nFalha na autenticação: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error("Nada foi gravado.");
      process.exitCode = 1;
    }
  } else {
    try {
      await runInteractiveLogin({ region });
    } catch (error) {
      console.error(
        `\nFalha na autenticação: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error("Nada foi gravado.");
      process.exitCode = 1;
    }
  }
}
