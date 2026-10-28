// Executar com Node e Playwright instalados: node tests/planejamento.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
let scripts = 0;
for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  if(!/src=|type=["']module/.test(match[1])) { new vm.Script(match[2]); scripts++; }
}
new vm.Script(fs.readFileSync(path.join(root,'planejamento.js'), 'utf8'));
const server = http.createServer((req,res)=>{
  const name = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if(!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file,(err,data)=>{
    res.writeHead(err?404:200, {'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html'});
    // Apenas a cópia de teste ignora as telas de identificação, sem efetuar login.
    res.end(err?'':file.endsWith('index.html')?data.toString().replace('\n</head>', '<style>#auth-screen,#mtm-chapa-screen{display:none!important}</style>\n</head>'):data);
  });
});
const sheet = (id, ttmu, manualTTP=0)=>({id,label:'Folha '+id,header:{empresa:'Empresa teste',projeto:'Projeto teste',manualTTP},rows:[{id:'r'+id,desc:'Atividade teste',code:'AA1',ttmu,tmu:ttmu,q:1,f:1,agrega:'Sim'}]});
const fixture = {
  sheets:[sheet('s1',1000),sheet('s2',500,80),sheet('s3',250)],
  pmData:{f1:{name:'Empresa teste',projects:[{id:'p1',name:'Projeto teste',sheets:['s1','s2'],plans:[],notes:[]},{id:'p2',name:'Outro projeto',sheets:['s3'],notes:[]}]}}
};
let browser;
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser = await chromium.launch(process.env.PLAYWRIGHT_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH}:{});
  const context = await browser.newContext({viewport:{width:1365,height:900},acceptDownloads:true});
  // Nenhuma conexão com autenticação, Firestore ou outro serviço real durante o teste.
  await context.route('**/*', route=>{
    const url = new URL(route.request().url());
    if(url.hostname !== '127.0.0.1' || url.pathname.endsWith('/firebase-mtm.js')) return route.abort();
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors=[];
  page.on('pageerror',err=>{errors.push(err.message);console.error('Erro na página:',err.message);});
  page.on('dialog', dialog=>dialog.accept(dialog.type()==='prompt'?'Planejamento teste':undefined));
  const url = 'http://127.0.0.1:'+server.address().port;
  await page.goto(url);
  await page.evaluate(data=>{
    pmData=data.pmData;
    sheets=data.sheets;
    pmSave();saveSheets();
  },fixture);
  await page.reload();
  await page.waitForTimeout(700);
  await page.evaluate(()=>{
    document.getElementById('auth-screen').style.display='none';
    showDashboard();
  });
  await page.locator('#db-proj-list button[onclick="openPlanning()"]').click();
  console.log('Acesso pela tela inicial OK.');
  await page.getByText('▦ Todos os planejamentos',{exact:true}).waitFor();
  await page.evaluate(()=>{planVoltarTodos();openFolderPage('f1');});
  await page.locator('.plj-novo').first().click();
  await page.locator('#plj-overlay:not(.hidden)').waitFor();
  await page.locator('.plj-tab tr[onclick*="s1"]').click();
  await page.locator('.plj-tab tr[onclick*="s2"]').click();
  await page.locator('.plj-qtd input').first().fill('2');
  await page.locator('.plj-takt').fill('30');
  let result = await page.evaluate(()=>{
    const p=pmData.f1.projects[0];return planCalcular(p.plans[0],p);
  });
  assert.equal(result.tp,93.6); // 36×2 + (18×1.2)
  assert.equal(result.tn,90);
  assert.equal(result.ops,4);
  console.log('Seleção e cálculo 93,6 s OK.');
  assert.match(await page.locator('#plj-resumo').innerText(),/93.60 s/);
  await page.locator('.plj-ord-btn[title="Descer"]').first().click();
  assert.deepEqual(await page.evaluate(()=>pmData.f1.projects[0].plans[0].sheets),['s2','s1']);
  await page.locator('#plj-sel-pasta').selectOption('f1');
  await page.locator('#plj-sel-projeto').selectOption('1');
  await page.locator('#plj-sel-folha').selectOption('s3');
  assert.equal(await page.evaluate(()=>planCalcular(pmData.f1.projects[0].plans[0]).tp),102.6);
  await page.getByRole('button',{name:'Máquina',exact:false}).click();
  await page.getByRole('button',{name:'Mão de obra',exact:false}).click();
  assert.equal(await page.evaluate(()=>planCalcular(pmData.f1.projects[0].plans[0]).recursos.tpEfetivo),51.3);
  // A impressão reúne somente as folhas selecionadas, preserva ordem e cálculo TTP.
  await page.evaluate(()=>{
    window.print=()=>{window.dispatchEvent(new Event('beforeprint'));};
    get('s2').header.conjuntoObs='Conjunto <teste> & observação';
  });
  await page.getByRole('button',{name:'Imprimir relatório / PDF',exact:false}).click();
  const printed=await page.evaluate(()=>({
    text:document.getElementById('print-area').textContent,
    count:document.querySelectorAll('#print-area .pa-folha').length,
    headings:Array.from(document.querySelectorAll('#print-area .pa-h1')).map(el=>el.textContent),
    data:JSON.stringify(pmData.f1.projects[0].plans[0])
  }));
  assert.equal(printed.count,4);
  assert.match(printed.text,/102,60 s/);
  assert.match(printed.text,/51,30 s/);
  assert.match(printed.text,/21,600/); // TTP 80%, mesma base do planejamento
  assert.match(printed.text,/Conjunto <teste> & observação/);
  assert.match(printed.headings[1],/Folha s2/);
  assert.match(printed.headings[2],/Folha s1/);
  assert.match(printed.headings[3],/Folha s3/);
  await page.pdf({path:process.env.PLANNING_PDF || '/tmp/planejamento-teste.pdf',preferCSSPageSize:true});
  assert.equal(await page.evaluate(()=>JSON.stringify(pmData.f1.projects[0].plans[0])),printed.data);
  await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
  assert.equal(await page.evaluate(()=>window._mtmPrintMode),'folhas');
  console.log('Impressão: resumo, ordem, TTP, quantidades, recursos e PDF OK.');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(()=>{pmLoad();bootSheetsOnce();return planCalcular(pmData.f1.projects[0].plans[0]).tp;}),102.6);
  await page.evaluate(()=>{document.getElementById('auth-screen').style.display='none';openPlanning();});
  await page.getByRole('button',{name:'Novo independente',exact:false}).click();
  await page.locator('#plj-sel-pasta').selectOption('f1');
  await page.locator('#plj-sel-projeto').selectOption('0');
  await page.locator('#plj-sel-folha').selectOption('s1');
  assert.equal(await page.evaluate(()=>planCalcular(planIndependentes()[0]).tp),36);
  await page.evaluate(()=>prepararPrintPlanejamento());
  assert.equal(await page.locator('#print-area .pa-folha').count(),2);
  assert.match(await page.locator('#print-area').textContent(),/Independente/);
  assert.equal(await page.evaluate(()=>{
    const pl=planIndependentes()[0];pl.sheets.push('ausente');
    try{prepararPrintPlanejamento();return false;}catch(e){return true;}
    finally{pl.sheets.pop();}
  }),true);
  assert.equal(await page.locator('#print-area').textContent(),'');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForTimeout(700);
  assert.equal(await page.evaluate(()=>planIndependentes()[0].sheets[0]),'s1');
  // Duplicar pasta mantém quantidades e aponta para as cópias, inclusive outro projeto.
  const duplicate = await page.evaluate(()=>{
    pmLoad();bootSheetsOnce();dbDuplicateFolder('f1');
    const fid=Object.keys(pmData).find(id=>id!=='f1');
    const p=pmData[fid].projects[0],pl=p.plans[0];
    return {total:planCalcular(pl).tp,ids:pl.sheets,quantity:planQtdDe(pl,p.sheets[0]),oldId:pmData.f1.projects[0].plans[0].id,newId:pl.id};
  });
  assert.equal(duplicate.total,102.6);
  assert.equal(duplicate.quantity,2);
  assert.ok(duplicate.ids.every(id=>!['s1','s2','s3'].includes(id)));
  assert.notEqual(duplicate.oldId,duplicate.newId);
  console.log('Recarga, independente e duplicação OK.');
  // Exportações reais e restauração com IDs remapeados nos dois modos.
  async function downloadData(action){
    const pending=page.waitForEvent('download');
    await page.evaluate(action);
    const download=await pending;
    return JSON.parse(fs.readFileSync(await download.path(),'utf8'));
  }
  const backup=await downloadData(()=>dbExportBackup());
  assert.equal(backup.standalonePlans.length,1);
  const individual=await downloadData(()=>dbSalvarProjetoIndividual('f1',0));
  assert.equal(individual.sheets.length,3);
  assert.equal(individual.projectManager.f1.projects[0].plans.length,1);
  const all=await downloadData(()=>saveAllProjectsFile());
  assert.equal(all.standalonePlans.length,1);
  async function importAll(mode){
    await page.evaluate(mode=>{window.chooseImportMode=(name,cb)=>cb(mode);},mode);
    await page.locator('#mtm-file-input').setInputFiles({name:'teste.mtm.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(all))});
    await page.waitForFunction(()=>localStorage.getItem('pmgr_v3')?.includes('Planejamento teste'));
    await page.waitForTimeout(300);
    return page.evaluate(()=>{
      const projects=Object.values(pmData).flatMap(f=>f.projects||[]);
      return {totals:projects.flatMap(p=>(p.plans||[]).map(pl=>planCalcular(pl).tp)),standalone:planIndependentes().map(pl=>planCalcular(pl).tp),valid:projects.every(p=>(p.plans||[]).every(pl=>pl.sheets.every(sid=>!!get(sid))))};
    });
  }
  const replaced=await importAll('replace');
  assert.deepEqual(replaced.totals,[102.6,102.6]);
  assert.deepEqual(replaced.standalone,[36]);
  assert.equal(replaced.valid,true);
  const merged=await importAll('merge');
  assert.equal(merged.totals.length,4);
  assert.ok(merged.totals.every(t=>t===102.6));
  assert.deepEqual(merged.standalone,[36,36]);
  assert.equal(merged.valid,true);
  // Importar pela pasta da empresa e restaurar backup preservam o módulo.
  await page.evaluate(()=>{showDashboard();openFolderPage('f1');});
  await page.locator('#db-import-file-f1').setInputFiles({name:'individual.mtm.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(individual))});
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>planCalcular(pmData.f1.projects.at(-1).plans[0]).tp),102.6);
  await page.evaluate(()=>{showDashboard();planIndepDefinir([]);});
  await page.locator('#dbBackupInput').setInputFiles({name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))});
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(()=>planCalcular(planIndependentes()[0]).tp),36);
  // A exclusão de um planejamento conserva as folhas do projeto.
  await page.evaluate(()=>{planAbrir('f1',0,0);planExcluir('f1',0,0);});
  assert.equal(await page.evaluate(()=>pmData.f1.projects[0].plans.length),0);
  assert.equal(await page.evaluate(()=>!!get('s1')&&!!get('s2')),true);
  await page.evaluate(()=>{openFolderPage('f1');planNovo('f1',0);planTodas(true);});
  await page.evaluate(()=>document.getElementById('db-dup-notice')?.remove());
  if(process.env.PLANNING_SCREENSHOT) await page.screenshot({path:process.env.PLANNING_SCREENSHOT.replace('.png','-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.locator('#plj-overlay').evaluate(el=>el.getBoundingClientRect().width),390);
  assert.ok(await page.locator('.plj-modal').evaluate(el=>el.getBoundingClientRect().right<=innerWidth));
  if(process.env.PLANNING_SCREENSHOT) await page.screenshot({path:process.env.PLANNING_SCREENSHOT,fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(`OK: ${scripts} scripts, seleção, quantidades, totais, recursos, recarga, independente, duplicação, exportação, importação replace/merge/pasta, backup, exclusão e celular.`);
})().catch(err=>{console.error(err);process.exitCode=1;}).finally(async()=>{
  if(browser) await browser.close();
  server.close();
});
