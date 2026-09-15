import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {redact} from './cloud-readonly-diagnostics.mjs';
const execute=promisify(execFile);
export const HTTP_PATHS=Object.freeze({version:'/api/version',printer:'/api/printer',job:'/api/job',connection:'/api/connection',files:'/api/files',settings:'/api/settings',logs:'/api/logs',server_info:'/server/info',objects:'/printer/objects/list',info:'/info'});
export function validatePrivateIPv4(ip) {
  if(typeof ip!=='string'||!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error('Private IPv4 address required');
  const n=ip.split('.').map(Number);
  if(n.some(v=>v>255)||!(n[0]===10||(n[0]===192&&n[1]===168)||(n[0]===172&&n[1]>=16&&n[1]<=31))) throw new Error('Private IPv4 address required');
  return ip;
}
export function parseCurlReply(stdout) {
  const index=stdout.lastIndexOf('\n__HTTP_STATUS__:');
  if(index<0) throw new Error('Missing HTTP status trailer');
  const status=Number(stdout.slice(index+17));
  const body=stdout.slice(0,index);
  let data;
  try{data=JSON.parse(body);}catch{data={text:body};}
  return {status,state:status>=200&&status<300?'reply':'http_error',data:redact(data)};
}
export async function readPrinterHttp({ip, endpoints=Object.keys(HTTP_PATHS),run=execute}) {
  validatePrivateIPv4(ip);
  if(!endpoints.length||endpoints.some(e=>!Object.hasOwn(HTTP_PATHS,e))) throw new Error('Unknown read endpoint');
  const results={ip,captured_at:new Date().toISOString(),transport:'curl-http-readonly',endpoints:{}};
  for(const name of [...new Set(endpoints)]) {
    try {
      // execFile, not a shell; fixed paths, no redirects, no credentials,
      // bounded duration and response size. Curl tolerates this device's LF headers.
      const {stdout}=await run('curl.exe',['--noproxy','*','--silent','--show-error','--max-time','5','--max-filesize','1048576','--write-out','\n__HTTP_STATUS__:%{http_code}',`http://${ip}${HTTP_PATHS[name]}`],{timeout:7000,maxBuffer:1100000,windowsHide:true});
      results.endpoints[name]={path:HTTP_PATHS[name],...parseCurlReply(stdout)};
    }catch(error){results.endpoints[name]={path:HTTP_PATHS[name],state:'transport_error',error:redact(error.message)};}
  }
  return results;
}
export function registerPrinterHttpReadings(server,z) {
  server.registerTool('printer_http_readonly_diagnostics',{
    description:'Bounded read-only HTTP GET probes for printer identity, state, files and logs. Uses curl for devices whose HTTP response formatting is rejected by Node fetch. Unsupported endpoints remain explicit; never sends POST, G-code, motion or print commands.',
    inputSchema:{ip:z.string(),endpoints:z.array(z.enum(Object.keys(HTTP_PATHS))).min(1).optional()},
    annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:true},
  },async args=>{
    try {const data=await readPrinterHttp(args);return{content:[{type:'text',text:JSON.stringify(data)}],structuredContent:data};}
    catch(error){return{isError:true,content:[{type:'text',text:redact(error.message)}]};}
  });
}
