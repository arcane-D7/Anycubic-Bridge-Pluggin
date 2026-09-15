import fs from 'node:fs';
import net from 'node:net';
import {fileURLToPath} from 'node:url';
import {collectCloudReadings} from './cloud-readonly-diagnostics.mjs';
// Explicit current printer target. TCP connects only: no protocol writes.
const ports=[22,80,443,2222,2883,7125,9883,18086,18088,18910];
const network=await Promise.all(ports.map(port=>new Promise(resolve=>{
  const socket=net.createConnection({host:'<LAN_IP>',port});
  let done=false;
  const finish=result=>{if(done)return;done=true;socket.destroy();resolve({port,...result});};
  socket.setTimeout(2500);
  socket.on('connect',()=>finish({state:'open'}));
  socket.on('error',e=>finish({state:'error',error:e.code}));
  socket.on('timeout',()=>finish({state:'timeout'}));
})));
const cloud=await collectCloudReadings({printerId:<PRINTER_ID>,queries:['axis','info','peripherie'],readOrders:['usb_files'],timeoutMs:10000});
const result={captured_at:new Date().toISOString(),network,cloud};
const destination=fileURLToPath(new URL(`../docs/evidence/recovery-alternatives-${Date.now()}.json`,import.meta.url));
fs.writeFileSync(destination,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({destination,network,usb:cloud.http_orders?.usb_files}));
