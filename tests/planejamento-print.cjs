const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root,'index.html'),'utf8');
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  if(!/src=|type=["']module/.test(m[1])) new vm.Script(m[2]);
}
const box = {innerHTML:''}, events={}, storage={};
const sheet=(id,tmu,ttp=0)=>({id,label:'Folha '+id,header:{manualTTP:ttp,conjuntoObs:'Texto <teste> & seguro'},rows:[{desc:'Movimento',code:'AA1',q:1,f:1,tmu,ttmu:tmu,agrega:'Sim'}]});
const sheets=[sheet('a',1000),sheet('b',500,80),sheet('c',250),sheet('fora',9999)];
const plan={id:'pl1',name:'Teste',date:'28/10/2026',sheets:['b','a','c'],qtds:{a:2},takt:30,recursos:[{tipo:'operador',dedicacao:100},{tipo:'maquina',dedicacao:100}]};
const ctx={console,Date,Math,JSON,Number,String,parseFloat,isFinite,
  document:{getElementById:id=>id==='print-area'?box:null,addEventListener(){},querySelector(){return null;}},
  localStorage:{getItem:k=>storage[k]||null,setItem:(k,v)=>storage[k]=v},
  pmData:{f:{name:'Empresa',projects:[{name:'Projeto',sheets:['a','b'],plans:[plan]},{name:'Externo',sheets:['c']}] }},
  get:id=>sheets.find(s=>s.id===id),scopedSheets:()=>[sheets[3]],
  alert:msg=>{ctx.lastAlert=msg;},addEventListener:(name,fn)=>events[name]=fn};
ctx.window=ctx;vm.createContext(ctx);
vm.runInContext(html.slice(html.indexOf('function computeSheetMetrics(s){'),html.indexOf('function updateTotals(sid){')),ctx);
vm.runInContext(html.slice(html.indexOf('function prepararPrint(folhasPlanejamento){'),html.indexOf('// Categoriza código MTM-UAS')),ctx);
vm.runInContext(fs.readFileSync(path.join(root,'planejamento.js'),'utf8'),ctx);
ctx.planAbrir('f',0,0);
const before=JSON.stringify(plan);
let prints=0;ctx.print=()=>{prints++;events.beforeprint();};
ctx.planImprimir();
assert.equal(prints,1);assert.equal(ctx._mtmPrintMode,'planejamento');
assert.match(box.innerHTML,/102,60 s/);assert.match(box.innerHTML,/51,30 s/);
assert.match(box.innerHTML,/21,600/);assert.match(box.innerHTML,/Externo/);
assert.match(box.innerHTML,/Texto &lt;teste&gt; &amp; seguro/);
assert.equal((box.innerHTML.match(/class="pa-folha"/g)||[]).length,4);
assert.ok(box.innerHTML.indexOf('PROCESSO MTM — Folha b')<box.innerHTML.indexOf('PROCESSO MTM — Folha a'));
assert.ok(!box.innerHTML.includes('Folha fora'));
assert.equal(JSON.stringify(plan),before);
events.afterprint();assert.equal(ctx._mtmPrintMode,'folhas');
plan.recursos.forEach(r=>r.dedicacao=0);ctx.prepararPrintPlanejamento();
assert.match(box.innerHTML,/Indisponível: dedicação total zero/);
plan.sheets.push('ausente');ctx.planImprimir();assert.equal(prints,1);assert.equal(box.innerHTML,'');
plan.sheets=[];ctx.planImprimir();assert.equal(prints,1);
ctx.planIndepDefinir([{id:'ind',name:'Independente',sheets:['c'],qtds:{c:2.5}}]);
ctx.planAbrirIndependente(0);ctx.planImprimir();
assert.equal(prints,2);assert.match(box.innerHTML,/22,50 s/);
assert.equal((box.innerHTML.match(/class="pa-folha"/g)||[]).length,2);
assert.match(box.innerHTML,/Independente/);
console.log('OK: sintaxe, relatório completo, ordem, escopo, TTP, quantidades fracionadas, recursos, independente, folhas ausentes, plano vazio, eventos e preservação de dados.');
