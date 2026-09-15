import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {AnycubicCloud,findSlicerJwt} from './anycubic-cloud.mjs';
import {redact} from './cloud-readonly-diagnostics.mjs';
// Source: anycubic-cloud-api/const/enums.py + api/functions.py. Do not use
// the legacy ORDER map for these read-only diagnostics: its numbers differ.
const cloud = new AnycubicCloud({access_token:findSlicerJwt(`${process.env.APPDATA}/AnycubicSlicerNext/log`),
  resources_dir:fileURLToPath(new URL('../resources',import.meta.url))});
await cloud.login();
const printer=(await cloud.listPrinters()).find(p=>Number(p.id)===<PRINTER_ID>);
if(!printer) throw new Error('Expected printer missing');
const output={captured_at:new Date().toISOString(),requests:[],events:[]};
const client=await cloud.connectMqtt(printer,{onEvent:e=>output.events.push(redact({topic:e.topic,data:e.data}))});
try {
  for(const [name,id] of [['axis',1214],['peripherie',1231],['light',1232],['multiColorBox',1206],['local_files',103]]) {
    try {output.requests.push({name,id,result:redact(await cloud.sendOrder(printer,id,{},name==='axis'?{projectId:0}:{}))});}
    catch(e){output.requests.push({name,id,error:redact(e.message)});}
    await new Promise(r=>setTimeout(r,1000));
  }
  await new Promise(r=>setTimeout(r,10000));
}finally{client.end(true);}
const destination=fileURLToPath(new URL(`../docs/evidence/http-read-orders-${Date.now()}.json`,import.meta.url));
fs.writeFileSync(destination,JSON.stringify(output,null,2),{flag:'wx'});
console.log(JSON.stringify({destination,requests:output.requests,topics:output.events.map(e=>e.topic)}));
