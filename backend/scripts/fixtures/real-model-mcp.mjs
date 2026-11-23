import { createInterface } from 'node:readline';
const mode=process.argv[2];
const define=(name,description,key)=>({name,description,inputSchema:{type:'object',properties:{[key]:{type:'string'}},required:[key]}});
const defs={ stock:define('lookup_stock','Retrieve east-site stock counts and source revision by SKU.','sku'),log:define('get_incident','Retrieve an archived incident log by incident ID.','incident'), primary:define('primary_index','Look up incident metadata in the authoritative primary index.','incident'), archive:define('query_archive','Look up legacy incident metadata in the archive when the primary index fails.','incident') };
for await (const line of createInterface({input:process.stdin})) {
  const {id,method,params}=JSON.parse(line); if(id===undefined) continue;
  let result;
  if(method==='initialize') result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'inventory-fixture',version:'1'}};
  else if(method==='tools/list') result=mode==='fallback' ? (params?.cursor==='archive' ? {tools:[defs.archive]} : {tools:[defs.primary],nextCursor:'archive'}) : {tools:[defs[mode]]};
  else if(method==='tools/call') {
    const v=params.arguments ?? {};
    let text, isError=false;
    if(params.name==='lookup_stock' && v.sku==='M-82') text='{"sku":"M-82","site":"east","onHand":63,"reserved":17,"revision":"r-2026-041"}';
    else if(params.name==='get_incident' && v.incident==='IC-19') text='incident: IC-19\nstage: reconcile-stock\nexitCode: 9';
    else if(params.name==='primary_index' && v.incident==='R-31') {text='Primary index is offline. Query the archive capability if available.';isError=true;}
    else if(params.name==='query_archive' && v.incident==='R-31') text='{"incident":"R-31","owner":"fulfillment","severity":"P2","source":"archive"}';
    else {text='No matching record for supplied arguments';isError=true;}
    result={content:[{type:'text',text}],isError};
  } else { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32601,message:'Unsupported'}})+'\n');continue; }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n');
}
