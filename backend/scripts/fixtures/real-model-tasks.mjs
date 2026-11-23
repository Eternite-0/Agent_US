// Immutable benchmark corpus. Hidden test bodies are never written into the agent workspace.
import { createHash } from 'node:crypto';

const mod = (name) => `lib/${name}.mjs`;
const build = (id, kind, prompt, source, writable, test, hidden, inspect, opts = {}) => ({
  id, kind, prompt, source, writable, test, hidden, inspect, ...opts,
});
export const tasks = [
  build('01-route-map', 'repository-understanding',
    'Create reports/routing.json documenting the effective paths of the orders and health handlers, which middleware wraps each, and the default port. Follow the actual imports, not the README examples. The JSON keys must be orders, health, ordersMiddleware, healthMiddleware, port. Do not modify implementation.',
    { 'README.md':'# Freight API\nThe old examples used /orders on port 3000. The current entry point is lib/server.mjs.\n',
      [mod('server')]:`import { mount } from './routes.mjs';\nexport const port=Number(process.env.PORT ?? 7421);\nexport const routes=mount('/api/v2');`,
      [mod('routes')]:`import { withTenant, passthrough } from './middleware.mjs';\nexport const mount=(prefix)=>[withTenant(prefix+'/shipments', 'orders'),passthrough('/readyz','health')];`,
      [mod('middleware')]:`export const withTenant=(path,id)=>({path,id,middleware:'tenant-context'});\nexport const passthrough=(path,id)=>({path,id,middleware:'none'});` },
    ['reports/routing.json'], null,
    `same(json('reports/routing.json'),{orders:'/api/v2/shipments',health:'/readyz',ordersMiddleware:'tenant-context',healthMiddleware:'none',port:7421});`, [mod('server'),mod('routes')]),
  build('02-config-precedence','repository-understanding',
    'Produce reports/config.json describing effective shipping settings for profiles dev and prod, first with an empty environment and then with RATE_LIMIT=0. Keys: dev, prod, zeroOverride. Each value has region and rateLimit; use prod for zeroOverride. Do not change code.',
    { 'README.md':'# Settings\nThe bootstrap path imports lib/bootstrap.mjs. Legacy docs may be stale.\n',
      [mod('bootstrap')]:`import { defaults, profiles } from './defaults.mjs';\nexport function config(profile, env={}) { const v={...defaults,...profiles[profile]}; if(env.RATE_LIMIT!==undefined)v.rateLimit=Number(env.RATE_LIMIT); return v; }`,
      [mod('defaults')]:`export const defaults={region:'west',rateLimit:25};\nexport const profiles={dev:{rateLimit:8},prod:{region:'eu',rateLimit:70}};` },
    ['reports/config.json'], null,
    `same(json('reports/config.json'),{dev:{region:'west',rateLimit:8},prod:{region:'eu',rateLimit:70},zeroOverride:{region:'eu',rateLimit:0}});`, [mod('bootstrap'),mod('defaults')]),
  build('03-money-rounding','code-change',
    'Fix invoice totals so percentage discounts are rounded to the nearest integer cent, and totals cannot go below zero. Keep the existing export and run the project test before declaring success.',
    { [mod('invoice')]:`export function totalCents(subtotal, percentage) {\n  return subtotal - subtotal * percentage / 100;\n}` }, [mod('invoice')],
    `const {totalCents}=await load('invoice'); same(totalCents(999,15),849);`,
    `const {totalCents}=await load('invoice'); same([totalCents(99,50),totalCents(333,1000),totalCents(101,0)],[49,0,101]);`, [mod('invoice')]),
  build('04-csv-quotes','code-change',
    'Fix the CSV encoder used by the export path: quote fields containing a comma, quote, CR, or LF, and double embedded quotes. Preserve the header and newline behavior. Run the project test.',
    { [mod('csv')]:`import { encode } from './field.mjs';\nexport const row=(fields)=>fields.map(encode).join(',')+'\\n';`,
      [mod('field')]:`export const encode=(field)=>String(field ?? '');` }, [mod('field')],
    `const {row}=await load('csv'); same(row(['x,y','n']), '"x,y",n\\n');`,
    `const {row}=await load('csv'); same(row(['x"y','a\\rb','a\\nb',null]),'"x""y","a\\rb","a\\nb",\\n');`, [mod('csv'),mod('field')]),
  build('05-negative-duration','test-repair',
    'Run the existing retry-delay test to reproduce a negative-attempt failure. Fix implementation only: attempts below zero should be clamped to zero, and keep the 30-second cap. Rerun the same test, not a replacement.',
    { [mod('retry')]:`export const delayMs = (attempt) => Math.min(30000, 250 * 2 ** attempt);` }, [mod('retry')],
    `const {delayMs}=await load('retry'); same(delayMs(-2),250);`,
    `const {delayMs}=await load('retry'); same([delayMs(-8),delayMs(0),delayMs(3),delayMs(20)],[250,250,2000,30000]);`, [mod('retry')], { initialFailure: true }),
  build('06-deprecated-reference','test-repair',
    'The pagination implementation now rejects a missing cursor rather than treating it as the first page. Run the test to reproduce the outdated assertion; update only the test to enforce the new documented behavior, retaining coverage of the explicit start cursor. Rerun it.',
    { [mod('page')]:`export const offset = (cursor) => { if (cursor == null) throw new TypeError('cursor required'); return cursor==='start'?0:Number(cursor); };` }, ['test/public.test.mjs'],
    `const {offset}=await load('page'); same(offset(),0); same(offset('start'),0);`,
    `const {offset}=await load('page'); throws(()=>offset(),/cursor required/); same(offset('start'),0); const revised=text('test/public.test.mjs'); ok(/throws|rejects/.test(revised)); ok(/['\"]start['\"]/.test(revised));`, [mod('page'),'test/public.test.mjs'], { initialFailure: true }),
  build('07-normalize-refactor','multi-file-refactor',
    'Extract the duplicate SKU normalization in lib/receive.mjs and lib/ship.mjs into lib/sku.mjs as normalizeSku. Both callers must import the helper and retain their public behavior. Verify the refactor with the project test.',
    { [mod('receive')]:`export const receive=(sku)=>'in:'+String(sku).trim().toUpperCase();`,
      [mod('ship')]:`export const ship=(sku)=>'out:'+String(sku).trim().toUpperCase();` }, [mod('receive'),mod('ship'),mod('sku')],
    `const {receive}=await load('receive'); const {ship}=await load('ship'); same([receive(' a '),ship('b')],['in:A','out:B']);`,
    String.raw`const {receive}=await load('receive');const {ship}=await load('ship'); const {normalizeSku}=await load('sku'); same([receive(' z '),ship(45),normalizeSku(' q9 ')],['in:Z','out:45','Q9']); for(const p of ['receive','ship']) {ok(/from\s+['\"]\.\/sku\.mjs['\"]/.test(text('lib/'+p+'.mjs')));ok(!text('lib/'+p+'.mjs').includes('toUpperCase'));}`, [mod('receive'),mod('ship')]),
  build('08-mcp-live-stock','mcp-cooperation',
    'Inventory quantities are not in this repo. Use the configured MCP inventory service to retrieve the on-hand count, reserved count, and snapshot revision for SKU M-82 at site east. Write reports/stock.json with sku, site, available (on-hand minus reserved), and revision.',
    { 'README.md': '# Inventory audit\nStock quantities live in the operator inventory service; cached local snapshots must not be used.\n' }, ['reports/stock.json'], null,
    `same(json('reports/stock.json'),{sku:'M-82',site:'east',available:46,revision:'r-2026-041'});`, [], { mcp: 'stock', requiredMcp: ['mcp__inventory__lookup_stock'] }),
  build('09-mcp-log','mcp-cooperation',
    'Retrieve the inventory incident IC-19 from the configured MCP service. Write reports/incident.json with incident, stage and historicalExit. The exit code in the retrieved log describes the past incident, not the current retrieval. Do not rerun the old job.',
    { 'README.md':'# Audit\nThe log is archived in the operator inventory service.\n' }, ['reports/incident.json'], null,
    `same(json('reports/incident.json'),{incident:'IC-19',stage:'reconcile-stock',historicalExit:9});`, [], { mcp: 'log', requiredMcp: ['mcp__inventory__get_incident'] }),
  build('10-mcp-incident-fallback','failure-recovery',
    'Use the configured incident index to look up incident R-31. Start with the primary index; if unavailable, use the archive source if discoverable. Produce reports/legacy.json with incident, owner, severity, source. Do not guess missing fields.',
    { 'README.md':'# Incident handoff\nThe primary index is preferred. Archived incidents may require an alternate index.\n' }, ['reports/legacy.json'], null,
    `same(json('reports/legacy.json'),{incident:'R-31',owner:'fulfillment',severity:'P2',source:'archive'});`, [],
    { mcp: 'fallback', requiredMcp: ['mcp__inventory__primary_index','mcp__inventory__query_archive'], structural: true }),
];

function checks(root, body) {
  return `import test from 'node:test';\nimport {deepStrictEqual as same,ok,throws} from 'node:assert/strict';\nimport {readFileSync} from 'node:fs';\nimport {resolve} from 'node:path';\nimport {pathToFileURL} from 'node:url';\nconst root=${root};\nconst text=(p)=>readFileSync(resolve(root,p),'utf8');\nconst json=(p)=>JSON.parse(text(p));\nconst load=(name)=>import(pathToFileURL(resolve(root,'lib',name+'.mjs')).href);\ntest('task contract',async()=>{${body}});\n`;
}
export function workspaceFiles(t) {
  const files = { 'package.json': '{"name":"freight-operations","private":true,"type":"module","scripts":{"test":"node --test test/public.test.mjs"}}\n',
    'README.md':'# Freight operations\nRun the project tests with `node --test test/public.test.mjs`.\n', ...t.source };
  if (t.test) files['test/public.test.mjs'] = checks('process.cwd()', t.test);
  return files;
}
export function judgeScript(t) { return checks('process.env.WORKSPACE_ROOT', t.hidden); }
export function fixtureDigest(t) {
  return createHash('sha256').update(JSON.stringify({ files: workspaceFiles(t), judge: judgeScript(t), prompt:t.prompt })).digest('hex');
}
