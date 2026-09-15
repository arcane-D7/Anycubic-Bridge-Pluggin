import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectCloudReadings, redact } from '../scripts/cloud-readonly-diagnostics.mjs';

test('unknown operations are rejected before contacting the printer', async () => {
  await assert.rejects(collectCloudReadings({printerId:688972, queries:['move']}), /Unknown/);
});
test('timeouts and publish errors preserve independently successful reads', async () => {
  let emit, ended = false;
  const cloud = {
    login: async () => {}, listPrinters: async () => [{id:688972}],
    connectMqtt: async (_, options) => { emit = options.onEvent; return {end:()=>{ended=true;}}; },
    publishCommand: async (_, type, action) => {
      assert.equal(action, 'query');
      if(type==='fan') throw new Error('test publish failure');
      if(type==='axis') emit({topic:'axis/report', data:{type, msgid:'axis-id', code:200, data:{coordinates:{z:4}}}});
      if(type==='info') emit({topic:'info/report', data:{type, msgid:'device-generated-id', code:200}});
      return `${type}-id`;
    },
  };
  const r = await collectCloudReadings({printerId:688972, timeoutMs:100, queries:['axis','info','print','fan'], cloud});
  assert.equal(r.queries.axis.state,'correlated_reply');
  assert.equal(r.queries.info.state,'uncorrelated_report');
  assert.equal(r.queries.print.state,'timeout');
  assert.equal(r.queries.fan.state,'publish_error');
  assert.equal(r.recovery.executable,false);
  assert.ok(ended);
});
test('credentials and signed links are removed recursively', () => {
  assert.deepEqual(redact({nested:[{access_token:'secret',rtspUrl:'private',message:'https://example.com/?token=secret'}]}),
    {nested:[{access_token:'[redacted]',rtspUrl:'[redacted]',message:'[redacted URL]'}]});
});
test('HTTP read orders are allowlisted and file responses correlated', async () => {
  await assert.rejects(collectCloudReadings({printerId:1,readOrders:['start_print']}),/Unknown HTTP/);
  let emit;
  const cloud={login:async()=>{},listPrinters:async()=>[{id:1}],
    connectMqtt:async(_,o)=>{emit=o.onEvent;return{end:()=>{}};},
    publishCommand:async()=> 'query-id',
    sendOrder:async(_,id)=>{
      assert.equal(id,103);
      emit({topic:'file/report',data:{type:'file',action:'listLocal',msgid:'file-id',code:200,data:{records:[]}}});
      return{msgid:'file-id'};
    }};
  const result=await collectCloudReadings({printerId:1,cloud,queries:['axis'],readOrders:['local_files'],timeoutMs:100});
  assert.equal(result.http_orders.local_files.state,'correlated_reply');
  assert.equal(result.queries.axis.state,'timeout');
});
test('MQTT connection failure does not discard HTTP diagnostics', async () => {
  const cloud={login:async()=>{},listPrinters:async()=>[{id:1,machine_type:20025}],
    connectMqtt:async()=>{throw new Error('Connection refused: Not authorized');},
    rawApi:async()=>({code:1,data:{test:true}})};
  const result=await collectCloudReadings({printerId:1,cloud,queries:['axis'],includeHttp:true});
  assert.equal(result.queries.axis.state,'connection_error');
  assert.equal(result.http.printer_info.state,'reply');
});
