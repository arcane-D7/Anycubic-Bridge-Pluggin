/**
 * printer-lan-tools.mjs — expõe o transporte LAN Mode nativo como ferramentas MCP.
 *
 * Lacuna fechada do audit (B): o handshake 18910 + MQTT local 9883 já estavam
 * implementados em printer-full-read.mjs mas não eram alcançáveis como tools.
 * Aqui registamos:
 *   - printer_lan_handshake — GET http://{ip}:18910/info + /ctrl assinado, devolve
 *     metadados do dispositivo e o broker MQTT local. READ-ONLY (nenhuma escrita).
 *   - printer_lan_read — publica queries no broker MQTT local (LAN) e captura os
 *     relatórios correspondentes. READ-ONLY: apenas actions "query"/"getInfo".
 *
 * Segurança:
 *   - Credenciais do broker/username/password NUNCA são devolvidas em claro;
 *     printer_lan_handshake devolve `username:"[redacted]"` quando não pedido e
 *     exige `include_credentials:true` + o utilizador humano para as expor
 *     (necessárias para o printer_lan_read construir o cliente MQTT).
 *   - printer_lan_read fica isolado: nunca publica comandos de escrita, só
 *     read actions (validadas contra READ_ONLY_ACTIONS).
 */
import { lanHandshake, collectLanReadings, QUERYABLE_SOURCES } from "./printer-full-read.mjs";
import { redact } from "./cloud-readonly-diagnostics.mjs";

function redactLanHandshake(handshake, { includeCredentials = false } = {}) {
  const out = { ...handshake };
  if (!includeCredentials) {
    if (out.username !== undefined) out.username = "[redacted]";
    if (out.password !== undefined) out.password = "[redacted]";
  }
  return redact(out);
}

/** Valida que um endereço IPv4 passado pelo tool não é público/URL. */
export function assertLanIp(ip) {
  if (typeof ip !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(ip))
    throw new Error("ip must be an IPv4 address (e.g. <LAN_IP>)");
  const first = Number(ip.split(".")[0]);
  if (first === 127 || first >= 224)
    throw new Error("ip must be a private LAN address (127.x/224+ are rejected)");
  return ip;
}

export function registerPrinterLanTools(server, z) {
  server.registerTool(
    "printer_lan_handshake",
    {
      title: "Discover a LAN-mode printer via the native 18910 handshake",
      description:
        "Read-only. Performs the signed Anycubic LAN handshake (GET :18910/info then POST ctrlInfoUrl with md5 signature) against a printer that is in LAN mode, returning model/serial/firmware metadata, the local MQTT broker host and port, and a redacted credential summary. Credentials (username/password) are only returned when include_credentials:true is set by the user. Fails cleanly with 'Printer is in CLOUD mode' when port 18910 is closed (the printer is on the cloud, not LAN)",
      inputSchema: {
        ip: z.string().max(64),
        timeout_ms: z.number().int().min(2000).max(15000).optional(),
        include_credentials: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ ip, timeout_ms, include_credentials }) => {
      try {
        assertLanIp(ip);
        const handshake = await lanHandshake(ip, Math.min(timeout_ms ?? 6000, 15000));
        const result = redactLanHandshake(handshake, {
          includeCredentials: include_credentials === true,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: redact(error.message ?? String(error)) }],
        };
      }
    },
  );

  server.registerTool(
    "printer_lan_read",
    {
      title: "Read printer state over the native LAN MQTT broker (read-only queries)",
      description:
        "Read-only. Performs the signed 18910 handshake, connects to the printer's local MQTT broker (mqtts://<ip>:9883) with the resulting credentials (never persisted), publishes read queries (info/tempature/fan/light/peripherie/aiSettings/multiColorBox) and captures the matching reports. Only READ actions are ever published — no printing, heating, motion, feeding or settings writes. Requires LAN mode (ports 18910+9883 reachable); fails cleanly with 'Printer is in CLOUD mode' in cloud mode. Broker credentials are obtained internally by the handshake and are redacted from every output.",
      inputSchema: {
        ip: z.string().max(64),
        sources: z.array(z.string().max(40)).optional(),
        timeout_ms: z.number().int().min(5000).max(30000).optional(),
        mqtt_port: z.number().int().min(1).max(65535).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ ip, sources, timeout_ms, mqtt_port }) => {
      try {
        assertLanIp(ip);
        const selected = Array.isArray(sources) && sources.length > 0 ? sources : QUERYABLE_SOURCES;
        const result = await collectLanReadings({
          ip,
          sources: selected,
          timeoutMs: Math.min(timeout_ms ?? 12000, 30000),
          mqttPort: mqtt_port,
        });
        const safe = redact(result);
        return {
          content: [{ type: "text", text: JSON.stringify(safe) }],
          structuredContent: safe,
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: redact(error.message ?? String(error)) }],
        };
      }
    },
  );
}
