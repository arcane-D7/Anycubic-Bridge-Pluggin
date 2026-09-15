import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const transport = new StdioClientTransport({command: process.execPath,
  args:[fileURLToPath(new URL('../dist/server.mjs',import.meta.url))], stderr:'pipe'});
const client = new Client({name:'readonly-verifier',version:'1.0.0'});
try {
  await client.connect(transport);
  const {tools} = await client.listTools();
  const found = tools.find(t=>t.name==='account_cloud_live_diagnostics');
  if(!found) throw new Error('New tool was not registered');
  const httpTool=tools.find(t=>t.name==='printer_http_readonly_diagnostics');
  if(!httpTool) throw new Error('HTTP diagnostic tool was not registered');
  console.log(JSON.stringify({http_tool:httpTool.name}));
  if(process.argv.includes('--http-live')) {
    const reply=await client.callTool({name:httpTool.name,arguments:{ip:'<LAN_IP>',endpoints:['version','logs']}});
    console.log(JSON.stringify(reply.structuredContent ?? reply));
  }
  console.log(JSON.stringify({tool:found.name,annotations:found.annotations,total_tools:tools.length}));
  if(process.argv.includes('--live')) {
    const reply = await client.callTool({name:found.name,arguments:{printer_id:<PRINTER_ID>,queries:['axis','info'],timeout_ms:5000}});
    console.log(JSON.stringify(reply));
  }
} finally { await client.close(); }
