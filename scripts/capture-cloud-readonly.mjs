import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectCloudReadings } from './cloud-readonly-diagnostics.mjs';
const printerId = Number(process.argv[2]);
const result = await collectCloudReadings({ printerId, includeHttp:true, readOrders:['local_files'],
  projectId:process.argv[3] ? Number(process.argv[3]) : undefined,
  gcodeId:process.argv[4] ? Number(process.argv[4]) : undefined });
const directory = fileURLToPath(new URL('../docs/evidence/', import.meta.url));
fs.mkdirSync(directory, { recursive: true });
const destination = `${directory}/cloud-${printerId}-${Date.now()}.json`;
fs.writeFileSync(destination, JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ destination, queries: Object.fromEntries(Object.entries(result.queries).map(([k,v]) => [k, {state:v.state,codes:v.device_codes}])) }));
