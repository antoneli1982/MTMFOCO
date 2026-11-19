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
  document:{title:'MTM em Foco',getElementById:id=>id==='print-area'?box:null,addEventListener(){},querySelector(){return null;}},
  localStorage:{getItem:k=>storage[k]||null,setItem:(k,v)=>storage[k]=v},
  pmData:{f:{name:'Empresa',projects:[{name:'Projeto',sheets:['a','b'],plans:[plan]},{name:'Externo',sheets:['c']}] }},
  get:id=>sheets.find(s=>s.id===id),scopedSheets:()=>[sheets[3]],
  alert:msg=>{ctx.lastAlert=msg;},addEventListener:(name,fn)=>events[name]=fn};
ctx.window=ctx;vm.createContext(ctx);
vm.runInContext(html.slice(html.indexOf('function computeSheetMetrics(s){'),html.indexOf('function updateTotals(sid){')),ctx);
// Formato acumulado e viradas por arredondamento, sem limite de 24 horas.
for(const [seconds, expected] of [[0,'00:00:00,0'],[743.3,'00:12:23,3'],[59.96,'00:01:00,0'],[3599.96,'01:00:00,0'],[90061.2,'25:01:01,2'],[360000,'100:00:00,0']]){
  assert.equal(ctx.mtmFormatarDuracao(seconds),expected);
}
const totalElements = {'tt-wrap-a':{style:{}},'tt-total-a':{},'tt-formula-a':{}};
const originalGetElement = ctx.document.getElementById;
ctx.document.getElementById=id=>totalElements[id] || originalGetElement(id);
ctx.frpTppSave=()=>{};
vm.runInContext(html.slice(html.indexOf('function frpCalcTotal('),html.indexOf('// Permite editar Peças por Ciclo')),ctx);
ctx.frpCalcTotal('a',{value:'20'},74.33,2,'peças');
assert.equal(totalElements['tt-total-a'].textContent,'00:12:23,3');
assert.match(totalElements['tt-formula-a'].textContent,/00:12:23,3/);
ctx.frpCalcTotal('a',{value:''},74.33,2,'peças');
assert.equal(totalElements['tt-wrap-a'].style.display,'none');
ctx.document.getElementById=originalGetElement;
vm.runInContext(html.slice(html.indexOf('var mtmTituloAntesPrint = null;'),html.indexOf('// Monta TODO o conteúdo formatado')),ctx);
vm.runInContext(html.slice(html.indexOf('function prepararPrint(folhasPlanejamento){'),html.indexOf('// Categoriza código MTM-UAS')),ctx);
vm.runInContext(fs.readFileSync(path.join(root,'planejamento.js'),'utf8'),ctx);
ctx.planAbrir('f',0,0);
const before=JSON.stringify(plan);
const sheetsBefore=JSON.stringify(sheets);
let prints=0;ctx.print=()=>{prints++;events.beforeprint();};
ctx.planImprimir();
assert.equal(prints,1);assert.equal(ctx._mtmPrintMode,'planejamento');
assert.equal(ctx.document.title,'Planejamento - Projeto');
assert.match(box.innerHTML,/Total em produção \(hh:mm:ss,d\)/);
assert.match(box.innerHTML,/00:01:42,6/);
assert.match(box.innerHTML,/102,60 s/);assert.match(box.innerHTML,/51,30 s/);
assert.match(box.innerHTML,/21,600/);assert.match(box.innerHTML,/Externo/);
assert.match(box.innerHTML,/Texto &lt;teste&gt; &amp; seguro/);
assert.equal((box.innerHTML.match(/class="pa-folha"/g)||[]).length,4);
assert.ok(box.innerHTML.indexOf('PROCESSO MTM — Folha b')<box.innerHTML.indexOf('PROCESSO MTM — Folha a'));
assert.ok(!box.innerHTML.includes('Folha fora'));
assert.equal(JSON.stringify(plan),before);
assert.equal(JSON.stringify(sheets),sheetsBefore);
const anexos=box.innerHTML.split('<div class="pa-folha">').slice(2);
assert.match(anexos[0],/📁 Projeto/);
assert.match(anexos[1],/📁 Projeto/);
assert.match(anexos[2],/📁 Externo/);
assert.match(box.innerHTML,/<div class="pa-h1">Planejamento · Projeto<\/div>/);
assert.match(anexos[0],/Relatório final · Projeto/);
assert.match(anexos[2],/Relatório final · Externo/);
anexos.forEach(anexo=>assert.match(anexo,/Integra o planejamento: <b>Teste<\/b> · Projeto do planejamento: Projeto/));
events.afterprint();assert.equal(ctx._mtmPrintMode,'folhas');
assert.equal(ctx.document.title,'MTM em Foco');
ctx.scopedSheets=()=>[sheets[0],sheets[2]];
ctx.mtmDefinirNomePDF('Relatório final');
assert.equal(ctx.document.title,'Relatório final - Projeto + Externo');
ctx.mtmRestaurarTituloPDF();
plan.recursos.forEach(r=>r.dedicacao=0);ctx.prepararPrintPlanejamento();
assert.match(box.innerHTML,/Indisponível: dedicação total zero/);
plan.sheets.push('ausente');ctx.planImprimir();assert.equal(prints,1);assert.equal(box.innerHTML,'');
plan.sheets=[];ctx.planImprimir();assert.equal(prints,1);
ctx.planIndepDefinir([{id:'ind',name:'Independente',sheets:['c'],qtds:{c:2.5}}]);
ctx.planAbrirIndependente(0);ctx.planImprimir();
assert.equal(ctx.document.title,'Planejamento - Independente');
assert.equal(prints,2);assert.match(box.innerHTML,/22,50 s/);
assert.equal((box.innerHTML.match(/class="pa-folha"/g)||[]).length,2);
assert.match(box.innerHTML,/Independente/);
console.log('OK: sintaxe, relatório completo, ordem, escopo, TTP, quantidades fracionadas, recursos, independente, folhas ausentes, plano vazio, eventos e preservação de dados.');

// Regressão: retirar/desmarcar/limpar não deixa atribuições ocultas nem as ressuscita.
ctx.computeSheetMetrics = () => ({stdSec:1800,totalSec:1800,va:0,nva:0,nnva:0,unc:0});
function cenario(){
  return {id:'reg',name:'Regressão de atribuições',sheets:['a','b'],takt:3600,
    ocupacaoPosicoes:[{posicao:'P1',turno:'T1',capacidadeSeg:3600,atividades:{a:1,b:1}}]};
}
for(const independente of [false,true]){
  for(const acao of ['remover','desmarcar','limpar']){
    let p = cenario(), salvo;
    ctx.pmSave = () => { salvo = JSON.stringify(p); };
    if(independente){ctx.planIndepDefinir([p]);ctx.planAbrirIndependente(0);}
    else {ctx.pmData.f.projects[0].plans=[p];ctx.planAbrir('f',0,0);}
    assert.equal(ctx.planOcupacaoCalc(p).grupos[0].percentual,100);
    if(acao==='remover') ctx.planSheetRemove('b');
    if(acao==='desmarcar') ctx.planToggleFolha('b');
    if(acao==='limpar') ctx.planTodas(false);
    assert.equal(Object.hasOwn(p.ocupacaoPosicoes[0].atividades,'b'),false);
    if(acao==='limpar'){
      assert.equal(Object.keys(p.ocupacaoPosicoes[0].atividades).length,0);
      assert.throws(()=>ctx.prepararPrintPlanejamento(),/Selecione atividades válidas/);
    }else{
      assert.equal(ctx.planOcupacaoCalc(p).grupos[0].percentual,50);
      ctx.prepararPrintPlanejamento();assert.match(box.innerHTML,/50\.0%/);
      assert.doesNotMatch(box.innerHTML,/Atividade ausente ou fora do planejamento/);
    }
    // Reabrir de uma cópia persistida, não apenas do mesmo objeto em memória.
    ctx.planFechar();
    if(independente){ctx.planIndependentes(true);p=ctx.planIndependentes()[0];ctx.planAbrirIndependente(0);}
    else {p=JSON.parse(salvo);ctx.pmData.f.projects[0].plans=[p];ctx.planAbrir('f',0,0);}
    ctx.planToggleFolha('b');
    assert.equal(Object.hasOwn(p.ocupacaoPosicoes[0].atividades,'b'),false);
    assert.equal(ctx.planOcupacaoCalc(p).grupos[0].percentual,acao==='limpar'?null:50);
    ctx.prepararPrintPlanejamento();
    if(acao==='limpar') assert.match(box.innerHTML,/Sem atribuição/);
    else assert.match(box.innerHTML,/50\.0%/);
  }
}
// Marcar todas pode retirar folhas externas; também deve retirar essas atribuições.
const externo=cenario();externo.sheets=['a','c'];externo.ocupacaoPosicoes[0].atividades={a:1,c:1};
ctx.pmData.f.projects[0].plans=[externo];ctx.pmSave=()=>{};ctx.planAbrir('f',0,0);ctx.planTodas(true);
assert.equal(Object.hasOwn(externo.ocupacaoPosicoes[0].atividades,'c'),false);
assert.equal(ctx.planOcupacaoCalc(externo).grupos[0].percentual,50);
console.log('OK: remover, desmarcar, limpar, recolocar, persistir/reabrir, impressão e folhas externas; projeto e independente.');
