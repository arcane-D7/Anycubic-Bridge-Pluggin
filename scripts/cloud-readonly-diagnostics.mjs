import { AnycubicCloud, findSlicerJwt } from './anycubic-cloud.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Known read operations from the existing LAN query implementation; Cloud
// support is measured per operation, never inferred from successful publishing.
export const READ_QUERIES = Object.freeze({
  axis: 'query', info: 'query', print: 'query', tempature: 'query',
  fan: 'query', light: 'query', peripherie: 'query', aiSettings: 'query',
  extfilbox: 'query', multiColorBox: 'getInfo',
});
export const HTTP_READ_ORDERS = Object.freeze({axis:1214,peripherie:1231,light:1232,multiColorBox:1206,local_files:103,usb_files:101});

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key,
      /token|password|secret|authorization|email|api.?key|file_download|download_url|url$/i.test(key)
        ? '[redacted]' : redact(item)]));
  if (typeof value === 'string') return value
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted JWT]')
    .replace(/https?:\/\/[^\s"<>]+/g, '[redacted URL]');
  return value;
}

export async function collectHttpReadings(cloud, {printerId, projectId, gcodeId, modelId}) {
  const requests = {
    printer_status: ['/v2/Printer/status', {id:printerId}],
    printer_info: ['/v2/printer/info', {id:printerId}],
    printer_tool: ['/v2/printer/tool', {id:printerId,model_id:modelId,type_function_id:13}],
    printer_functions: ['/v2/printer/functions', {id:printerId,model_id:modelId}],
    ace: ['/v2/printer/getMultiColorBoxInfo', {id:printerId}],
    ...(projectId ? {
      project_info: ['/v2/project/info', {id:projectId}],
      project_monitor: ['/v2/project/monitor', {id:projectId}],
      history_detail: ['/v5/project/printHistory/detail', {task_id:projectId}],
    } : {}),
    ...(gcodeId ? {gcode_info_fdm: ['/work/gcode/infoFdm', {id:gcodeId}]} : {}),
  };
  const results = {};
  // Sequential, bounded requests avoid a burst against the account API.
  for (const [name, [endpoint, query]] of Object.entries(requests)) {
    try { results[name] = {endpoint,query,state:'reply',response:redact(await cloud.rawApi('GET',endpoint,{query}))}; }
    catch(error) { results[name] = {endpoint,query,state:'error',error:redact(error.message)}; }
  }
  return results;
}

export async function collectCloudReadings({ printerId, timeoutMs = 20000,
  queries = Object.keys(READ_QUERIES), cloud: injected, includeHttp = false, projectId, gcodeId, readOrders = [] } = {}) {
  if (!Number.isSafeInteger(printerId) || printerId <= 0) throw new Error('Explicit positive printerId required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000) throw new Error('Invalid timeoutMs');
  if (!queries.length || queries.some(q => !Object.hasOwn(READ_QUERIES, q))) throw new Error('Unknown read query');
  if (readOrders.some(q=>!Object.hasOwn(HTTP_READ_ORDERS,q))) throw new Error('Unknown HTTP read order');
  for (const id of [projectId,gcodeId]) if(id !== undefined && (!Number.isSafeInteger(id) || id <= 0)) throw new Error('Invalid project/gcode ID');
  const cloud = injected ?? new AnycubicCloud({
    access_token: process.env.ANYCUBIC_CLOUD_TOKEN || findSlicerJwt(path.join(process.env.APPDATA, 'AnycubicSlicerNext', 'log')),
    resources_dir: fileURLToPath(new URL('../resources', import.meta.url)),
  });
  await cloud.login();
  const printer = (await cloud.listPrinters()).find(p => Number(p.id) === printerId);
  if (!printer) throw new Error('Requested printer is not bound to this account');
  const events = [];
  const result = { printer_id: printerId, collected_at: new Date().toISOString(),
    transport: 'cloud-mqtt', queries: {}, events,
    recovery: { executable: false, reason: 'Coordinates alone do not establish homing, offsets or crash position' } };
  let client;
  try {
    client = await cloud.connectMqtt(printer, { onEvent: event => {
      events.push(redact({ topic: event.topic, received_at: new Date().toISOString(), data: event.data }));
    }});
  } catch(error) {
    result.connection_error=redact(error.message);
    for(const type of queries) result.queries[type]={state:'connection_error'};
    if(includeHttp) result.http=await collectHttpReadings(cloud,{printerId,projectId,gcodeId,modelId:printer.machine_type});
    return result;
  }
  try {
    for (const type of [...new Set(queries)]) {
      try {
        const msgid = await cloud.publishCommand(printer, type, READ_QUERIES[type], {}, client);
        result.queries[type] = { msgid, state: 'awaiting_reply' };
      } catch (error) {
        result.queries[type] = { state: 'publish_error', error: redact(error.message) };
      }
    }
    result.http_orders = {};
    for(const name of [...new Set(readOrders)]) {
      try {
        const ack=await cloud.sendOrder(printer,HTTP_READ_ORDERS[name],{},name==='axis'?{projectId:0}:{});
        result.http_orders[name]={id:HTTP_READ_ORDERS[name],ack:redact(ack)};
      }catch(error){result.http_orders[name]={state:'error',error:redact(error.message)};}
    }
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    for(const [name,entry] of Object.entries(result.http_orders)) {
      if(entry.state==='error')continue;
      const type=['local_files','usb_files'].includes(name)?'file':name;
      const action=name==='local_files'?'listLocal':name==='usb_files'?'listUdisk':undefined;
      const reports=events.filter(e=>e.data?.type===type && (!action || e.data?.action===action));
      const exact=reports.filter(e=>e.data?.msgid===entry.ack?.msgid);
      entry.state=exact.length?'correlated_reply':reports.length?'uncorrelated_report':'timeout';
      entry.replies=exact.length?exact:reports;
    }
    for (const [type, query] of Object.entries(result.queries)) {
      if (query.state === 'publish_error') continue;
      const exact = events.filter(e => e.data?.type === type && e.data?.msgid === query.msgid);
      const reports = events.filter(e => e.data?.type === type);
      query.state = exact.length ? 'correlated_reply' : reports.length ? 'uncorrelated_report' : 'timeout';
      query.replies = exact.length ? exact : reports;
      // A reply may contain a device error; retain it instead of calling it success.
      query.device_codes = query.replies.map(e => e.data?.code);
    }
    if (includeHttp) result.http = await collectHttpReadings(cloud, {printerId,projectId,gcodeId,modelId:printer.machine_type});
    return result;
  } finally { client.end(true); }
}

export function registerCloudReadingsTool(server, z) {
  server.registerTool('account_cloud_live_diagnostics', {
    description: 'Read-only Cloud MQTT queries. Returns per-query timeouts, device codes, correlated replies and raw redacted fields. Never moves, homes, heats, uploads or resumes a print.',
    inputSchema: { printer_id: z.number().int().positive(),
      timeout_ms: z.number().int().min(1000).max(60000).default(20000),
      include_http: z.boolean().default(false),
      project_id: z.number().int().positive().optional(),
      gcode_id: z.number().int().positive().optional(),
      read_orders: z.array(z.enum(Object.keys(HTTP_READ_ORDERS))).optional(),
      queries: z.array(z.enum(Object.keys(READ_QUERIES))).min(1).optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ printer_id, timeout_ms, queries, include_http, project_id, gcode_id, read_orders }) => {
    try {
      const data = await collectCloudReadings({ printerId: printer_id, timeoutMs: timeout_ms, queries,
        includeHttp:include_http,projectId:project_id,gcodeId:gcode_id,readOrders:read_orders });
      return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: redact(error.message) }] };
    }
  });
}
