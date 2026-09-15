import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {readPrinterHttp} from './printer-http-readonly.mjs';
const result=await readPrinterHttp({ip:'<LAN_IP>'});
const destination=fileURLToPath(new URL(`../docs/evidence/printer-http-${Date.now()}.json`,import.meta.url));
fs.writeFileSync(destination,JSON.stringify(result,null,2),{flag:'wx'});
console.log(JSON.stringify({destination,...result}));
