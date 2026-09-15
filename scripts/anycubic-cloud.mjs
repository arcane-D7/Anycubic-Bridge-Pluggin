/**
 * Anycubic Cloud Real Client (workbench API + MQTT).
 *
 * Reverse-engineered protocol, cross-validated live on hardware (2026-09-04):
 *  - Login:  POST {API}/v3/public/loginWithAccessToken {device_type:"pcf", access_token: <JWT>}
 *            -> data.token = XX-Token session
 *  - Signed headers (all calls): Xx-Device-Type/Nonce/Signature/Timestamp/Version,
 *    Xx-Signature = md5(app_id + ts + version + secret + nonce + app_id)
 *  - Printers: GET {API}/work/printer/getPrinters (XX-Token)
 *  - Orders:   POST {API}/work/operation/sendOrder {printer_id, order_type, ...}
 *  - MQTT: mqtts://mqtt-universe.anycubic.com:8883, mutual TLS (shared slicer identity),
 *    username "user|pcf|<email>|<md5(clientId+pwd+clientId)>", password = RSA-PKCS1v15(XX-Token, CA key) b64
 *  - Topics: anycubic/anycubicCloud/v1/printer/app/<machine_type>/<key>/#  (reports)
 *            anycubic/anycubicCloud/v1/printer/public/<machine_type>/<key>/<type>  (commands)
 *
 * Identity constants originate from WaresWichall/hass-anycubic_cloud + Nino6689/anycubic-cloud-api
 * (GPL-3.0), which extracted them from Anycubic's own slicer. This is a shared client
 * identity, not a per-user secret.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import mqtt from "mqtt";

const AC_AID = "f9b3528877c94d5c9c5af32245db46ef";
const AC_SEC = "0cf75926606049a3937f56b0373b99fb";
const AC_VER = "V3.0.0";
const BASE = "https://cloud-universe.anycubic.com";
const API_ROOT = `${BASE}/p/p/workbench/api`;
const MQTT_HOST = "mqtt-universe.anycubic.com";
const MQTT_PORT = 8883;
const TOPIC_PRE = "anycubic/anycubicCloud/v1";

// Legacy control IDs require revalidation; do not infer safety from this map.
// Read IDs below were corrected and tested on 2026-09-10.
// START_PRINT/PAUSE/RESUME/STOP follow the Nino6689/anycubic-cloud-api
// AnycubicOrderID IntEnum (1/2/3/4). START_PRINT=1 and STOP_PRINT=4 were
// LIVE-VALIDATED 2026-09-11 (task <TASK_ID> started the physical Kobra S1;
// STOP_PRINT cleared residual task <TASK_ID>). 1240 answered "Operation
// successful" but never created a task.
export const ORDER = Object.freeze({
  START_PRINT: 1,
  PAUSE_PRINT: 2,
  RESUME_PRINT: 3,
  STOP_PRINT: 4,
  SET_AI_SETTINGS: 1243,
  SET_TEMPERATURE: 1214,
  SET_FAN_SPEED: 1215,
  SET_PRINT_SPEED: 1216,
  SET_LIGHT_STATUS: 1217,
  MOVE_AXLE: 1226,
  MOVE_AXLE_TURN_OFF: 1227,
  QUERY_AXIS_POSITION: 1214,
  LIST_LOCAL_FILES: 103,
  LIST_UDISK_FILES: 1235,
  DELETE_LOCAL_FILE: 1236,
  DELETE_UDISK_FILE: 1237,
  QUERY_PERIPHERALS: 1231,
  GET_LIGHT_STATUS: 1232,
  MULTI_COLOR_BOX_GET_INFO: 1206,
  MULTI_COLOR_BOX_DRY: 1251,
  MULTI_COLOR_BOX_AUTO_FEED: 1252,
  MULTI_COLOR_BOX_SET_SLOT: 1253,
  FEED_FILAMENT: 1254,
  CAMERA_OPEN: 1260,
});

const MATERIAL_TYPES = ["PLA", "PETG", "ABS", "PACF", "PC", "ASA", "HIPS", "PA", "PLA SE"];

export class AnycubicCloudError extends Error {
  constructor(message, code, http) {
    super(message);
    this.name = "AnycubicCloudError";
    this.code = code;
    this.http = http;
  }
}

export class AnycubicCloud {
  constructor({ access_token, resources_dir, log }) {
    this.access_token = access_token; // slicer JWT (access_token)
    this.resources_dir = resources_dir;
    this.log = log ?? (() => {});
    this.xxToken = null;
    this.user = null;
    this.msgid = 0;
  }

  // ---- signed headers -------------------------------------------------
  #authHeaders(withToken) {
    const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 32);
    const ts = Date.now().toString();
    const sig = crypto
      .createHash("md5")
      .update(`${AC_AID}${ts}${AC_VER}${AC_SEC}${nonce}${AC_AID}`)
      .digest("hex");
    const h = {
      "Xx-Device-Type": "pcf",
      "Xx-Is-Cn": "1",
      "Xx-Nonce": nonce,
      "Xx-Signature": sig,
      "Xx-Timestamp": ts,
      "Xx-Version": AC_VER,
      "XX-LANGUAGE": "US",
      "Content-Type": "application/json",
    };
    if (withToken && this.xxToken) h["XX-Token"] = this.xxToken;
    return h;
  }

  async #api(method, endpoint, { body, query, withToken = true } = {}) {
    const url = new URL(API_ROOT + endpoint);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: this.#authHeaders(withToken),
      signal: AbortSignal.timeout(15000),
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON */
    }
    if (!res.ok)
      throw new AnycubicCloudError(`HTTP ${res.status} on ${endpoint}`, json?.code, res.status);
    if (json && json.code !== 1)
      throw new AnycubicCloudError(json.msg || `code ${json.code}`, json.code, res.status);
    return json;
  }

  // ---- session --------------------------------------------------------
  async login() {
    const res = await this.#api("POST", "/v3/public/loginWithAccessToken", {
      body: { device_type: "pcf", access_token: this.access_token },
      withToken: false,
    });
    this.xxToken = res.data.token;
    const user = await this.#api("GET", "/user/profile/userInfo");
    this.user = user.data;
    this.log(`login ok: user=${this.user.id}`);
    return { xxToken: this.xxToken, user: this.user };
  }

  // ---- printers --------------------------------------------------------
  async listPrinters() {
    const res = await this.#api("GET", "/work/printer/getPrinters");
    return res.data ?? [];
  }

  /**
   * Raw workbench call that merges auth headers (XX-Token + Xx-* signature).
   * Used by the upload flow (lockStorageSpace / newUploadFile / AWS PUT).
   */
  async rawApi(method, endpoint, { params, query } = {}) {
    const url = new URL(API_ROOT + endpoint);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: this.#authHeaders(true),
      signal: AbortSignal.timeout(15000),
      body: params ? JSON.stringify(params) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!json || json.code !== 1)
      throw new AnycubicCloudError(json?.msg ?? `HTTP ${res.status}`, json?.code, res.status);
    return json;
  }

  /** Public alias of the signed auth headers (XX-Token included) for ad-hoc probes. */
  authHeadersPublic() {
    return this.#authHeaders(true);
  }

  // ---- orders (cloud) --------------------------------------------------
  #nextMsgid() {
    return crypto.randomUUID();
  }

  /**
   * Send an order via the cloud workbench.
   * ⚠ Wire quirks (validated against the real API, mirroring hass-anycubic):
   *  - Project-level orders (START_PRINT=1, PAUSE=2, RESUME=3, STOP=4) keep
   *    order_id as an INTEGER and take `projectId` (e.g. 0 for a new task, or
   *    the task id for STOP). START_PRINT was live-validated 2026-09-11: with
   *    order_id=1 + full slice_param + ams_info mapping the device started
   *    (task <TASK_ID> reached `printing`); the old 1240 hypothesis answered
   *    "Operation successful" yet never created a task.
   *  - Printer-level orders (MOVE_AXLE, SET_TEMPERATURE, ...) stringify the
   *    order_id and must OMIT project_id (MOVE_AXLE silently ignored when
   *    project_id:0 is present).
   */
  async sendOrder(printer, order_id, order_data, { projectId, extra } = {}) {
    // Project-level control orders (START/PAUSE/RESUME/STOP) keep order_id as
    // an INTEGER on the wire (AnycubicProjectCtrlOrderRequest, live-validated
    // 2026-09-11). Printer-level orders take the stringified form.
    const projectControl = order_id === 1 || order_id === 2 || order_id === 3 || order_id === 4;
    const body = {
      printer_id: printer.id,
      order_id: projectControl ? order_id : String(order_id),
      msgid: this.#nextMsgid(),
      timestamp: Date.now(),
      data: order_data ?? {},
      ...(projectId !== undefined ? { project_id: projectId } : {}),
      ...extra,
    };
    const res = await this.#api("POST", "/work/operation/sendOrder", { body });
    return res.data;
  }

  // HTTP read orders work with the corrected IDs. Earlier claims that HTTP
  // ignores printer-level requests came from testing an incorrect order map.
  // Control wrappers below remain legacy and need independent validation.
  async publishCommand(printer, type, action, data, client) {
    const topic = `anycubic/anycubicCloud/v1/pc/printer/${printer.machine_type}/${printer.key}/${type}`;
    const msgid = this.#nextMsgid();
    await new Promise((resolve, reject) =>
      client.publish(
        topic,
        JSON.stringify({
          type,
          action,
          timestamp: Date.now(),
          msgid,
          data: data ?? {},
        }),
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    return msgid;
  }

  setTemperature(printer, { nozzle, bed }) {
    const data = { type: 2, target_hotbed_temp: bed ?? 0, target_nozzle_temp: nozzle ?? 0 };
    return this.sendOrder(printer, ORDER.SET_TEMPERATURE, data);
  }
  setFanSpeed(printer, { fan, aux, box }) {
    // slicer sends exactly one key per call
    const data =
      fan != null
        ? { fan_speed_pct: fan }
        : aux != null
          ? { aux_fan_speed_pct: aux }
          : box != null
            ? { box_fan_level: box }
            : {};
    return this.sendOrder(printer, ORDER.SET_FAN_SPEED, data);
  }
  setLight(printer, on, { light_type = 2, brightness = 100 } = {}) {
    return this.sendOrder(printer, ORDER.SET_LIGHT_STATUS, {
      type: light_type,
      status: on ? 1 : 0,
      brightness: on ? brightness : 0,
    });
  }
  setAiDetection(printer, enabled, current = {}) {
    return this.sendOrder(printer, ORDER.SET_AI_SETTINGS, {
      ai_settings: {
        status: enabled ? 3 : 0,
        type: current.type ?? 2,
        count: current.count ?? 60,
        sensitivity_level: current.sensitivity_level ?? [1, 1],
        notice_type: current.notice_type ?? [0, 1],
      },
    });
  }
  moveAxis(printer, { axis, move_type, distance = 0 }) {
    return this.sendOrder(printer, ORDER.MOVE_AXLE, { axis, move_type, distance });
  }
  setAceSlot(printer, slotIndex, { material, r, g, b }, boxId = 0) {
    return this.sendOrder(printer, ORDER.MULTI_COLOR_BOX_SET_SLOT, {
      multi_color_box: [
        { id: boxId, slots: [{ color: [r, g, b], index: slotIndex, type: material }] },
      ],
    });
  }
  aceDry(printer, { status, target_temp, duration, box_id = 0 }) {
    return this.sendOrder(printer, ORDER.MULTI_COLOR_BOX_DRY, {
      multi_color_box: [
        { drying_status: { status, target_temp, duration, remain_time: 0 }, id: box_id },
      ],
    });
  }
  aceAutoFeed(printer, enabled, boxId = 0) {
    return this.sendOrder(printer, ORDER.MULTI_COLOR_BOX_AUTO_FEED, {
      multi_color_box: [{ id: boxId, auto_feed: enabled ? 1 : 0 }],
    });
  }
  aceGetInfo(printer) {
    return this.sendOrder(printer, ORDER.MULTI_COLOR_BOX_GET_INFO, {});
  }
  listLocalFiles(printer) {
    return this.sendOrder(printer, ORDER.LIST_LOCAL_FILES, {});
  }

  // ---- MQTT telemetry --------------------------------------------------
  async connectMqtt(printer, { onEvent, durationMs = 0 } = {}) {
    if (!this.xxToken) throw new AnycubicCloudError("login() required before MQTT");
    const resDir = this.resources_dir;
    const caPem = fs.readFileSync(path.join(resDir, "mqtt-tls", "ca.crt"), "utf8");
    const cert = fs.readFileSync(path.join(resDir, "mqtt-tls", "client.crt"));
    const key = fs.readFileSync(path.join(resDir, "mqtt-tls", "client.key"));

    // password = RSA-PKCS1v15(XX-Token, CA pubkey) -> base64
    // node-forge is CJS: import the default export correctly under ESM
    const forgeMod = await import("node-forge");
    const forge = forgeMod.default ?? forgeMod;
    const caCert = forge.pki.certificateFromPem(caPem);
    const caPubPem = forge.pki.publicKeyToPem(caCert.publicKey);
    const rsaPub = crypto.createPublicKey(caPubPem);
    const password = crypto
      .publicEncrypt(
        { key: rsaPub, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(this.xxToken, "utf8"),
      )
      .toString("base64");

    const email = this.user.user_email || String(this.user.id);
    // Broker rejects randomized IDs (live test: CONNACK 5, Not authorized).
    // Serialize diagnostic sessions: this fixed identity can displace a peer.
    const clientId = crypto
      .createHash("md5")
      .update(email + "pcf")
      .digest("hex");
    const sigMd5 = crypto
      .createHash("md5")
      .update(`${clientId}${password}${clientId}`)
      .digest("hex");
    const username = `user|pcf|${email}|${sigMd5}`;

    const topics = [
      `${TOPIC_PRE}/printer/app/${printer.machine_type}/${printer.key}/#`,
      `${TOPIC_PRE}/+/public/${printer.machine_type}/${printer.key}/#`,
    ];

    return new Promise((resolve, reject) => {
      const client = mqtt.connect({
        host: MQTT_HOST,
        port: MQTT_PORT,
        protocol: "mqtts",
        clientId,
        username,
        password,
        ca: [caPem],
        cert,
        key,
        // The vendor client certificate uses a legacy signature. Scope OpenSSL
        // compatibility to this broker; certificate/hostname verification stays on.
        ciphers: "DEFAULT@SECLEVEL=0",
        rejectUnauthorized: true,
        protocolVersion: 4,
        clean: true,
        keepalive: 60,
      });
      const connectTimer = setTimeout(() => {
        client.end(true);
        reject(new AnycubicCloudError("mqtt connect/subscription timeout", "TIMEOUT"));
      }, 15000);
      client.on("error", (e) => {
        clearTimeout(connectTimer);
        this.log(`mqtt error: ${e.message}`);
        client.end(true);
        reject(e);
      });
      client.on("connect", () => {
        this.log("mqtt connected");
        client.subscribe(topics, { qos: 0 }, (error, granted) => {
          clearTimeout(connectTimer);
          if (error || granted?.some((g) => g.qos === 128)) {
            client.end(true);
            reject(error ?? new AnycubicCloudError("mqtt subscription refused"));
          } else resolve(client);
        });
      });
      client.on("message", (topic, payload) => {
        let data = null;
        try {
          data = JSON.parse(payload.toString());
        } catch {
          return;
        }
        // ignore bare acks {msgid: ...}
        const parts = topic.split("/");
        const suffix = parts.slice(-2).join("/");
        if (parts.at(-1) === "response" && data && Object.keys(data).length === 1) return;
        onEvent?.({ topic: suffix, data, raw: topic, ts: Date.now() });
      });
      if (durationMs > 0)
        setTimeout(() => {
          client.end(true);
          resolve(null);
        }, durationMs);
    });
  }
}

export function findSlicerJwt(logDir) {
  // Agnostic resolution: expand %APPDATA% and ignore inert placeholder paths
  // (sanitized docs/templates), so the same code works on any machine.
  let dir = logDir;
  if (dir && dir.includes("%APPDATA%")) dir = dir.replace("%APPDATA%", process.env.APPDATA ?? "");
  if (!dir || dir.includes("<") || dir.startsWith("<")) return null;
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("debug_"))
      .sort();
    for (const f of files.reverse()) {
      try {
        const txt = fs.readFileSync(path.join(dir, f), "utf8");
        const m = txt.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
        if (m) return m[0];
      } catch {
        /* unreadable */
      }
    }
  } catch {
    /* no log dir */
  }
  return null;
}

export const ANYCUBIC_MATERIALS = MATERIAL_TYPES;
