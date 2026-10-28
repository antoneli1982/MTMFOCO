// Recuperado de 362bb76^, adaptado ao app atual.
(function(){
'use strict';

function esc(v){
  return String(v == null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function seg(v){ return (Math.round((v||0)*100)/100).toFixed(2); }
function minu(v){ return ((v||0)/60).toFixed(2); }

// O planejamento usa o mesmo tempo padrão exibido na folha atual.
function tempoPadrao(sh, m){ return m.stdSec; }
window.tempoPadraoFolha = tempoPadrao;

/* ── acesso aos planejamentos de um projeto ── */
function planosDe(p){
  if(!p) return [];
  if(!Array.isArray(p.plans)) p.plans = [];
  return p.plans;
}
window.planosDe = planosDe;

/* Planejamentos independentes: usam o mesmo modelo dos planos de projeto,
   mas ficam em um repositório próprio para não criar empresa/projeto fictício. */
var PLAN_INDEP_KEY = 'mtm_process_plans_independent_v1';
var planosIndepCache = null;
var planTodosAtivo = false;

function planIndependentes(recarregar){
  if(!recarregar && Array.isArray(planosIndepCache)) return planosIndepCache;
  try{
    var raw = JSON.parse(localStorage.getItem(PLAN_INDEP_KEY) || '[]');
    planosIndepCache = Array.isArray(raw) ? raw : [];
  }catch(e){ planosIndepCache = []; }
  return planosIndepCache;
}
function planIndepSalvar(){
  try{ localStorage.setItem(PLAN_INDEP_KEY, JSON.stringify(planIndependentes())); }
  catch(e){
    alert('Não foi possível salvar o planejamento independente. Gere um backup e libere espaço no navegador.');
    throw e;
  }
}
function planIndepDefinir(lista){
  planosIndepCache = Array.isArray(lista) ? lista : [];
  planIndepSalvar();
}
function planRemapImport(lista, sidMap, novosIds){
  return (Array.isArray(lista) ? lista : []).map(function(orig){
    var pl;
    try{ pl = JSON.parse(JSON.stringify(orig)); }catch(e){ pl = {}; }
    if(novosIds || !pl.id) pl.id = 'pli_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
    pl.sheets = (pl.sheets || []).map(function(id){ return sidMap[id] || id; });
    if(pl.qtds && typeof pl.qtds === 'object'){
      var q = {};
      Object.keys(pl.qtds).forEach(function(id){ q[sidMap[id] || id] = pl.qtds[id]; });
      pl.qtds = q;
    }
    return pl;
  });
}
function planPersist(a){
  if(a && a.independente) planIndepSalvar();
  else if(typeof pmSave === 'function') pmSave();
}
window.planIndependentes = planIndependentes;
window.planIndepDefinir = planIndepDefinir;
window.planRemapImport = planRemapImport;
window.planSheetIdsForExport = function(p){
  var ids = (p.sheets || []).slice();
  planosDe(p).forEach(function(pl){
    (pl.sheets || []).forEach(function(sid){ if(ids.indexOf(sid) === -1) ids.push(sid); });
  });
  return ids;
};

function achaProjeto(fid, pi){
  var f = (typeof pmData !== 'undefined') ? pmData[fid] : null;
  return (f && f.projects && f.projects[pi]) ? { f:f, p:f.projects[pi] } : null;
}

/* ───────────────────────────────────────────────────────────────
   CALCULO — soma das atividades escolhidas
   ─────────────────────────────────────────────────────────────── */
function planQtdDe(plano, sid){
  var v = plano.qtds ? parseFloat(plano.qtds[sid]) : NaN;
  return (isFinite(v) && v > 0) ? v : 1;
}
window.planQtdDe = planQtdDe;

function planCalcular(plano, proj){
  var itens = [], tn = 0, tp = 0, va = 0, nva = 0, nnva = 0, unc = 0;
  (plano.sheets || []).forEach(function(sid){
    var sh = (typeof get === 'function') ? get(sid) : null;
    if(!sh) return;
    var m = (typeof computeSheetMetrics === 'function') ? computeSheetMetrics(sh) : null;
    if(!m) return;
    var qtd = planQtdDe(plano, sid);
    var tpUnit = tempoPadrao(sh, m);
    tn += m.totalSec * qtd; tp += tpUnit * qtd;
    va += m.va * qtd; nva += m.nva * qtd; nnva += m.nnva * qtd; unc += m.unc * qtd;
    itens.push({ sid:sid, label:sh.label, processo:(sh.header && sh.header.processo) || '', m:m,
                 qtd:qtd, tpUnit:tpUnit, tpTotal:tpUnit * qtd });
  });
  var takt = parseFloat(plano.takt) || 0;
  var ops  = takt > 0 ? Math.ceil(tp / takt) : 0;
  var opsE = takt > 0 ? (tp / takt) : 0;             // operadores exatos (fracionado)
  var satu = (takt > 0 && ops > 0) ? (tp / (takt * ops) * 100) : 0;
  var sobra = (takt > 0 && ops > 0) ? (takt * ops - tp) : 0;
  return {
    itens:itens, tn:tn, tp:tp, takt:takt,
    ops:ops, opsExato:opsE, saturacao:satu, folga:sobra,
    va:va, nva:nva, nnva:nnva, unc:unc,
    pecasHora: tp > 0 ? Math.floor(3600 / tp) : 0,
    recursos: planRecursosCalc(plano, tp)
  };
}
window.planCalcular = planCalcular;

/* ───────────────────────────────────────────────────────────────
   RECURSOS ALOCADOS — máquina e/ou mão de obra, com dedicação
   individual de cada recurso. Base do cálculo: 1 recurso (máquina
   e/ou operador) a 100% de dedicação = fator 1 (tempo do processo
   igual ao Tempo Total apurado nas folhas). Cada recurso soma
   dedicacao/100 ao fator; o tempo do processo cai proporcionalmente
   (tempoEfetivo = TEMPO TOTAL ÷ fator).
   ─────────────────────────────────────────────────────────────── */
function planRecursosCalc(plano, tp){
  var lista = Array.isArray(plano.recursos) ? plano.recursos : [];
  var fator = 0, nMaq = 0, nOp = 0;
  lista.forEach(function(r){
    var d = parseFloat(r.dedicacao);
    if(!isFinite(d) || d < 0) d = 0;
    if(d > 100) d = 100;
    fator += d / 100;
    if(r.tipo === 'maquina') nMaq++; else nOp++;
  });
  if(!lista.length) fator = 1; // sem recursos informados: assume 1 recurso a 100%
  var tpEf = fator > 0 ? tp / fator : tp;
  return {
    lista:lista, fator:fator, nMaquinas:nMaq, nOperadores:nOp,
    tpEfetivo:tpEf,
    pecasHoraEfetiva: tpEf > 0 ? Math.floor(3600 / tpEf) : 0
  };
}
window.planRecursosCalc = planRecursosCalc;

function planRecursoAdd(tipo){
  var a = planAtual();
  if(!a) return;
  var arr = a.pl.recursos = a.pl.recursos || [];
  arr.push({
    id: 'r' + Date.now() + Math.random().toString(36).slice(2, 7),
    tipo: tipo === 'maquina' ? 'maquina' : 'operador',
    label: '',
    dedicacao: 100
  });
  planPersist(a);
  planRenderRecursos();
}
window.planRecursoAdd = planRecursoAdd;

function planRecursoRemove(id){
  var a = planAtual();
  if(!a) return;
  var arr = a.pl.recursos || [];
  var i = -1;
  arr.forEach(function(r, idx){ if(r.id === id) i = idx; });
  if(i !== -1) arr.splice(i, 1);
  planPersist(a);
  planRenderRecursos();
}
window.planRecursoRemove = planRecursoRemove;

function planRecursoAch(a, id){
  var arr = a.pl.recursos || [];
  var achado = null;
  arr.forEach(function(r){ if(r.id === id) achado = r; });
  return achado;
}

function planRecursoSetTipo(id, v){
  var a = planAtual();
  if(!a) return;
  var r = planRecursoAch(a, id);
  if(!r) return;
  r.tipo = v === 'maquina' ? 'maquina' : 'operador';
  planPersist(a);
  planRenderRecursos();
}
window.planRecursoSetTipo = planRecursoSetTipo;

function planRecursoSetLabel(id, v){
  var a = planAtual();
  if(!a) return;
  var r = planRecursoAch(a, id);
  if(!r) return;
  r.label = v;
  planPersist(a);
}
window.planRecursoSetLabel = planRecursoSetLabel;

function planRecursoSetDedicacao(id, v){
  var a = planAtual();
  if(!a) return;
  var r = planRecursoAch(a, id);
  if(!r) return;
  r.dedicacao = v;
  planPersist(a);
  planRenderRecursosSum(); // só os números — mantém o foco no input
}
window.planRecursoSetDedicacao = planRecursoSetDedicacao;

function planRenderRecursos(){
  var a = planAtual();
  var rowsEl = document.getElementById('plj-recursos-rows');
  if(!a || !rowsEl) return;
  var lista = a.pl.recursos || [];
  if(!lista.length){
    rowsEl.innerHTML = '<div class="plj-vazio" style="padding:12px">Nenhum recurso informado ainda.'
      + '<br><small>Sem recursos, o cálculo assume 1 recurso (máquina e/ou operador) a 100%.</small></div>';
  } else {
    rowsEl.innerHTML = lista.map(function(r){
      return '<div class="plj-rec-row">'
        +   '<select class="plj-rec-tipo" onchange="planRecursoSetTipo(\'' + r.id + '\', this.value)">'
        +     '<option value="operador"' + (r.tipo !== 'maquina' ? ' selected' : '') + '>🧍 Mão de obra</option>'
        +     '<option value="maquina"' + (r.tipo === 'maquina' ? ' selected' : '') + '>🔧 Máquina</option>'
        +   '</select>'
        +   '<input class="plj-rec-nome" type="text" placeholder="Nome (opcional)" value="' + esc(r.label || '') + '" '
        +     'oninput="planRecursoSetLabel(\'' + r.id + '\', this.value)">'
        +   '<div class="plj-rec-ded">'
        +     '<input type="number" min="0" max="100" step="1" value="' + esc(r.dedicacao != null ? r.dedicacao : 100) + '" '
        +       'oninput="planRecursoSetDedicacao(\'' + r.id + '\', this.value)"><span>%</span>'
        +   '</div>'
        +   '<button class="plj-rec-del" onclick="planRecursoRemove(\'' + r.id + '\')" title="Remover">✕</button>'
        + '</div>';
    }).join('');
  }
  planRenderRecursosSum();
}
window.planRenderRecursos = planRenderRecursos;

function planRenderRecursosSum(){
  var a = planAtual();
  var el = document.getElementById('plj-recursos-sum');
  if(!a || !el) return;
  var c = planCalcular(a.pl, a.p);
  var rec = c.recursos;
  var cmpHtml = '';
  if(c.takt > 0){
    var ok = rec.tpEfetivo <= c.takt;
    cmpHtml = '<div class="plj-vered ' + (ok ? 'plj-vered-ok' : 'plj-vered-alerta') + '" style="margin-top:9px">'
      + (ok
          ? '✅ Com estes recursos, o tempo efetivo (<b>' + seg(rec.tpEfetivo) + ' s</b>) atende ao Takt (' + seg(c.takt) + ' s).'
          : '⚠️ Com estes recursos, o tempo efetivo (<b>' + seg(rec.tpEfetivo) + ' s</b>) excede o Takt (' + seg(c.takt) + ' s). Faltam recursos.')
      + '</div>';
  }
  el.innerHTML = '<div class="plj-kpis" style="margin-top:10px">'
    + kpi('Fator de Recursos', rec.fator.toFixed(2) + '×', 'var(--purple)',
          rec.lista.length ? (rec.nMaquinas + ' máq. · ' + rec.nOperadores + ' m.o.') : 'padrão: 1 recurso a 100%')
    + kpi('Tempo Efetivo', seg(rec.tpEfetivo) + ' s', 'var(--green)', minu(rec.tpEfetivo) + ' min')
    + kpi('Peças/hora', rec.pecasHoraEfetiva || '—', 'var(--accent)', 'com estes recursos')
    + '</div>' + cmpHtml;
}
window.planRenderRecursosSum = planRenderRecursosSum;


/* ───────────────────────────────────────────────────────────────
   PLANEJAMENTOS JA EXISTENTES — "Analise de Capacidade Combinada"
   do Relatorio Final. Ficam em mtm_frp_scope_v1 (folha base -> folhas
   somadas) e mtm_frp_simul_v1 (folhas marcadas como PARALELAS, que
   nao entram no tempo sequencial). Aqui apenas LEMOS e mostramos.
   ─────────────────────────────────────────────────────────────── */
function frpScopeRaw(){
  try{ return JSON.parse(localStorage.getItem('mtm_frp_scope_v1') || '{}') || {}; }
  catch(e){ return {}; }
}
function frpSimulRaw(){
  try{ return JSON.parse(localStorage.getItem('mtm_frp_simul_v1') || '{}') || {}; }
  catch(e){ return {}; }
}
window.frpScopeRaw = frpScopeRaw;

/* Devolve os planejamentos do Relatorio Final que pertencem a este projeto */
function planExistentes(p){
  var escopo = frpScopeRaw(), simul = frpSimulRaw(), out = [];
  (p && p.sheets || []).forEach(function(base){
    var ids = escopo[base];
    if(!Array.isArray(ids) || ids.length < 2) return;      // 1 folha so = nao e combinacao
    var shBase = (typeof get === 'function') ? get(base) : null;
    if(!shBase) return;
    var par = simul[base] || {};
    var seq = 0, paralelo = 0, itens = [];
    ids.forEach(function(id){
      var sh = (typeof get === 'function') ? get(id) : null;
      if(!sh) return;
      var m = (typeof computeSheetMetrics === 'function') ? computeSheetMetrics(sh) : null;
      if(!m) return;
      var t = tempoPadrao(sh, m);
      var ehPar = !!par[id];
      if(ehPar) paralelo += t; else seq += t;
      itens.push({ id:id, label:sh.label, t:t, paralelo:ehPar });
    });
    out.push({
      base: base, label: shBase.label,
      itens: itens, seq: seq, paralelo: paralelo, total: seq + paralelo,
      nPar: itens.filter(function(x){ return x.paralelo; }).length
    });
  });
  return out;
}
window.planExistentes = planExistentes;

/* Abre o Relatorio Final ja posicionado na analise daquela folha */
function planAbrirRelatorio(sid){
  if(typeof showFinalReport !== 'function'){
    alert('Relatorio Final indisponivel nesta tela.');
    return;
  }
  showFinalReport();
  setTimeout(function(){
    var el = document.getElementById('frp-scope-' + sid)
          || document.getElementById('frp-h-' + sid);
    if(el && el.scrollIntoView) el.scrollIntoView({ behavior:'smooth', block:'center' });
  }, 450);
}
window.planAbrirRelatorio = planAbrirRelatorio;

function blocoExistentes(p){
  var lista = planExistentes(p);
  if(!lista.length) return '';
  var linhas = lista.map(function(x){
    var extra = x.nPar
      ? ' \u00b7 ' + x.nPar + ' paralela(s), fora do sequencial'
      : '';
    return '<div class="plj-item plj-item-frp" onclick="event.stopPropagation();planAbrirRelatorio(\'' + x.base + '\')">'
      + '<span class="plj-ico">\uD83D\uDCC8</span>'
      + '<span class="plj-txt"><b>' + esc(x.label) + '</b>'
      +   '<em>' + x.itens.length + ' atividade(s) \u00b7 ' + seg(x.seq) + ' s sequencial' + extra + '</em></span>'
      + '<span class="plj-go">\u2192</span></div>';
  });
  return '<div class="plj-hdr plj-hdr-frp">Planejamentos do Relat\u00f3rio Final <span>'
       + lista.length + '</span></div>'
       + '<div class="plj-list">' + linhas.join('') + '</div>'
       + '<div class="plj-nota">Somas j\u00e1 montadas na An\u00e1lise de Capacidade Combinada. '
       + 'Clique para abrir no Relat\u00f3rio Final.</div>';
}

/* ───────────────────────────────────────────────────────────────
   CARTAO DO PROJETO — lista dos planejamentos
   ─────────────────────────────────────────────────────────────── */
function dbListaPlanejamentos(fid, pi, p){
  var planos = planosDe(p);
  var linhas = planos.map(function(pl, k){
    if(!pl || typeof pl !== 'object') return '';
    var c;
    try{ c = planCalcular(pl, p) || {takt:0,ops:0,tp:0}; }
    catch(err){ console.warn('MTM: planejamento inválido ignorado', err); c = {takt:0,ops:0,tp:0}; }
    var badge = c.takt > 0
      ? '<span class="plj-ops">' + c.ops + ' op.</span>'
      : '<span class="plj-ops plj-ops-off">sem takt</span>';
    return '<div class="plj-item" onclick="event.stopPropagation();planAbrir(\'' + fid + '\',' + pi + ',' + k + ')">'
      + '<span class="plj-ico">\uD83D\uDCCA</span>'
      + '<span class="plj-txt"><b>' + esc(pl.name) + '</b>'
      +   '<em>' + (pl.sheets || []).length + ' atividade(s) \u00b7 '
      +   seg(c.tp) + ' s (' + minu(c.tp) + ' min)</em></span>'
      + badge
      + '<span class="plj-go">\u2192</span></div>';
  });

  return '<div class="plj-box">'
    + blocoExistentes(p)
    + '<div class="plj-hdr">Planejamentos <span>' + planos.length + '</span></div>'
    + (linhas.length
        ? '<div class="plj-list">' + linhas.join('') + '</div>'
        : '<div class="plj-vazio">Nenhum planejamento ainda.<br>'
          + '<small>Um planejamento soma as atividades para dar o tempo total do processo.</small></div>')
    + '<button class="plj-novo" onclick="event.stopPropagation();planNovo(\'' + fid + '\',' + pi + ')">'
    + '\uFF0B Novo planejamento</button>'
    + '</div>';
}
window.dbListaPlanejamentos = dbListaPlanejamentos;

/* ───────────────────────────────────────────────────────────────
   VISÃO GERAL — reúne planejamentos vinculados e independentes
   ─────────────────────────────────────────────────────────────── */
function planTodosDados(){
  if(typeof pmLoad === 'function') pmLoad();
  if(typeof bootSheetsOnce === 'function') bootSheetsOnce();
  var out = [], d = (typeof pmData !== 'undefined' && pmData) ? pmData : {};
  Object.keys(d).forEach(function(fid){
    if(fid === '__flat__' || !d[fid]) return;
    var f = d[fid];
    (f.projects || []).forEach(function(p, pi){
      planosDe(p).forEach(function(pl, k){
        out.push({ tipo:'projeto', fid:fid, pi:pi, k:k, f:f, p:p, pl:pl,
          origem:(f.name || 'Empresa') + ' › ' + (p.name || 'Projeto') });
      });
      planExistentes(p).forEach(function(fr){
        out.push({
          tipo:'relatorio', fid:fid, pi:pi, f:f, p:p, frp:fr,
          pl:{ id:'frp_' + fr.base, name:'Análise combinada — ' + fr.label, date:'—', takt:'',
               sheets:fr.itens.map(function(it){ return it.id; }) },
          calculado:{ tp:fr.seq, takt:0, ops:0 },
          origem:(f.name || 'Empresa') + ' › ' + (p.name || 'Projeto') + ' › Relatório Final'
        });
      });
    });
  });
  planIndependentes().forEach(function(pl, k){
    out.push({ tipo:'independente', k:k, f:{name:'Independente'}, p:{name:'Sem projeto',sheets:[]},
      pl:pl, origem:'Fora dos projetos' });
  });
  return out;
}

function planFiltrarTodos(v){
  var q = String(v || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  document.querySelectorAll('[data-plan-todos-busca]').forEach(function(el){
    var txt = (el.getAttribute('data-plan-todos-busca') || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'');
    el.style.display = !q || txt.indexOf(q) !== -1 ? '' : 'none';
  });
}
window.planFiltrarTodos = planFiltrarTodos;

function planRenderTodos(manterRolagem){
  var host = document.getElementById('db-proj-list');
  if(!host) return;
  planTodosAtivo = true;
  var dados = planTodosDados();
  var vinculados = dados.filter(function(x){ return x.tipo === 'projeto'; }).length;
  var independentes = dados.filter(function(x){ return x.tipo === 'independente'; }).length;
  var relatorios = dados.filter(function(x){ return x.tipo === 'relatorio'; }).length;
  var atividades = dados.reduce(function(n,x){ return n + ((x.pl.sheets || []).length); }, 0);
  var linhas = dados.map(function(x){
    var c = x.calculado || planCalcular(x.pl, x.p);
    var acao = x.tipo === 'independente' ? 'planAbrirIndependente(' + x.k + ')'
      : x.tipo === 'relatorio' ? 'planAbrirRelatorio(\'' + x.frp.base + '\')'
      : 'planAbrir(\'' + x.fid + '\',' + x.pi + ',' + x.k + ')';
    var tipo = x.tipo === 'independente'
      ? '<span style="background:var(--greenBg);color:var(--green);border:1px solid rgba(0,229,160,.35);padding:3px 8px;border-radius:7px;font-size:9px;font-weight:800">INDEPENDENTE</span>'
      : x.tipo === 'relatorio'
      ? '<span style="background:var(--orangeBg);color:var(--orange);border:1px solid rgba(255,149,0,.35);padding:3px 8px;border-radius:7px;font-size:9px;font-weight:800">RELATÓRIO FINAL</span>'
      : '<span style="background:var(--accentBg);color:var(--accent);border:1px solid rgba(0,212,255,.3);padding:3px 8px;border-radius:7px;font-size:9px;font-weight:800">PROJETO</span>';
    var busca = esc((x.pl.name || '') + ' ' + x.origem);
    return '<div data-plan-todos-busca="' + busca + '" onclick="' + acao + '" '
      + 'style="display:grid;grid-template-columns:minmax(190px,1.6fr) minmax(170px,1.5fr) 92px 105px 92px 34px;gap:10px;align-items:center;background:var(--surface3);border:1px solid var(--border);border-radius:10px;padding:11px 13px;cursor:pointer;margin-bottom:7px">'
      + '<div><div style="font-size:12.5px;font-weight:800;color:var(--text)">' + esc(x.pl.name || 'Planejamento') + '</div>'
      + '<div style="font-size:10px;color:var(--text3);margin-top:3px">Criado em ' + esc(x.pl.date || '—') + '</div></div>'
      + '<div><div style="font-size:10.5px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(x.origem) + '</div>'
      + '<div style="margin-top:4px">' + tipo + '</div></div>'
      + '<div style="text-align:right"><b style="color:var(--purple);font-size:13px">' + (x.pl.sheets || []).length + '</b><div style="font-size:9px;color:var(--text3)">atividades</div></div>'
      + '<div style="text-align:right"><b style="color:var(--green);font-size:13px">' + seg(c.tp) + ' s</b><div style="font-size:9px;color:var(--text3)">' + minu(c.tp) + ' min</div></div>'
      + '<div style="text-align:right"><b style="color:var(--blue);font-size:13px">' + (c.takt > 0 ? c.ops : '—') + '</b><div style="font-size:9px;color:var(--text3)">' + (c.takt > 0 ? 'operadores' : 'sem takt') + '</div></div>'
      + '<div style="color:var(--accent);font-size:16px;font-weight:800">→</div></div>';
  }).join('');
  host.innerHTML = '<div style="background:var(--surface2);border:1px solid var(--border2);border-radius:14px;padding:18px">'
    + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px">'
    + '<button onclick="planVoltarTodos()" style="background:var(--surface3);border:1px solid var(--border2);color:var(--text);padding:8px 13px;border-radius:8px;cursor:pointer;font-weight:700">← Empresas</button>'
    + '<div><div style="font-size:18px;font-weight:800;color:var(--text)">▦ Todos os planejamentos</div><div style="font-size:10.5px;color:var(--text3)">Visão consolidada de todos os planejamentos realizados</div></div>'
    + '<span style="flex:1"></span><button onclick="planNovoIndependente()" style="background:var(--greenBg);color:var(--green);border:1px solid var(--green);padding:9px 15px;border-radius:8px;font-weight:800;cursor:pointer">＋ Novo independente</button></div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:9px;margin-bottom:14px">'
    + kpi('Planejamentos', dados.length, 'var(--purple)', 'total realizado')
    + kpi('Em projetos', vinculados, 'var(--accent)', 'vinculados')
    + kpi('Independentes', independentes, 'var(--green)', 'fora dos projetos')
    + kpi('Relatório Final', relatorios, 'var(--orange)', 'análises combinadas')
    + kpi('Atividades', atividades, 'var(--orange)', 'soma dos vínculos') + '</div>'
    + '<input type="search" oninput="planFiltrarTodos(this.value)" placeholder="🔎 Buscar planejamento, empresa ou projeto..." style="width:100%;box-sizing:border-box;background:var(--surface3);border:1px solid var(--border2);border-radius:9px;padding:11px 13px;color:var(--text);font-family:inherit;margin-bottom:12px">'
    + '<div style="overflow-x:auto">' + (linhas
        ? '<div style="min-width:740px">' + linhas + '</div>'
        : '<div class="plj-vazio" style="padding:30px">Nenhum planejamento criado ainda.<br><small>Crie dentro de um projeto ou use “Novo independente”.</small></div>') + '</div>'
    + '</div>';
  if(!manterRolagem) host.scrollIntoView({behavior:'smooth',block:'start'});
}
window.planRenderTodos = planRenderTodos;
window.planResetView = function(){ planTodosAtivo = false; };
window.openPlanning = function(){
  if(typeof showDashboard === 'function') showDashboard();
  planRenderTodos();
};

function planVoltarTodos(){
  planTodosAtivo = false;
  if(typeof dbRenderList === 'function') dbRenderList();
}
window.planVoltarTodos = planVoltarTodos;

function planNovoIndependente(){
  if(typeof bootSheetsOnce === 'function') bootSheetsOnce();
  var lista = planIndependentes();
  var nome = prompt('Nome do planejamento independente:\n(ex.: Fluxo completo, Cenário futuro, Estudo transversal)',
                    'PLANEJAMENTO INDEPENDENTE ' + (lista.length + 1));
  if(nome === null) return;
  nome = nome.trim() || ('PLANEJAMENTO INDEPENDENTE ' + (lista.length + 1));
  lista.push({
    id:'pli_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    name:nome, date:new Date().toLocaleDateString('pt-BR'), createdAt:new Date().toISOString(),
    takt:'', sheets:[], qtds:{}, recursos:[]
  });
  planIndepSalvar();
  planAbrirIndependente(lista.length - 1);
}
window.planNovoIndependente = planNovoIndependente;

/* ───────────────────────────────────────────────────────────────
   CRIAR / EXCLUIR
   ─────────────────────────────────────────────────────────────── */
function planNovo(fid, pi){
  if(typeof pmLoad === 'function') pmLoad();
  if(typeof bootSheetsOnce === 'function') bootSheetsOnce();
  var alvo = achaProjeto(fid, pi);
  if(!alvo){ alert('Projeto nao encontrado.'); return; }

  var planos = planosDe(alvo.p);
  var nome = prompt('Nome do planejamento:\n(ex.: Ciclo completo, Turno A, Cenario proposto)',
                    'PLANEJAMENTO ' + (planos.length + 1));
  if(nome === null) return;
  nome = nome.trim() || ('PLANEJAMENTO ' + (planos.length + 1));

  planos.push({
    id: 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2,7),
    name: nome,
    date: new Date().toLocaleDateString('pt-BR'),
    takt: '',
    sheets: []                       // comeca vazio: o usuario escolhe as atividades
  });
  if(typeof pmSave === 'function') pmSave();
  planAbrir(fid, pi, planos.length - 1);
}
window.planNovo = planNovo;

function planExcluir(fid, pi, k){
  if(PL && PL.independente){
    var avulsos = planIndependentes();
    var av = avulsos[PL.k];
    if(!av) return;
    if(!confirm('Excluir o planejamento independente "' + av.name + '"?\n\nAs folhas NÃO serão apagadas — apenas este agrupamento.')) return;
    avulsos.splice(PL.k, 1);
    planIndepSalvar();
    planFechar();
    if(planTodosAtivo) planRenderTodos(true); else if(typeof dbRenderList === 'function') dbRenderList();
    return;
  }
  var alvo = achaProjeto(fid, pi);
  if(!alvo) return;
  var planos = planosDe(alvo.p);
  var pl = planos[k];
  if(!pl) return;
  if(!confirm('Excluir o planejamento "' + pl.name + '"?\n\n'
            + 'As folhas NAO sao apagadas — apenas este agrupamento.')) return;
  planos.splice(k, 1);
  if(typeof pmSave === 'function') pmSave();
  planFechar();
  if(planTodosAtivo) planRenderTodos(true);
  else if(typeof openFolderPage === 'function') openFolderPage(fid);
}
window.planExcluir = planExcluir;

function planRenomear(fid, pi, k){
  if(PL && PL.independente){
    var av = planIndependentes()[PL.k];
    if(!av) return;
    var novo = prompt('Novo nome do planejamento:', av.name);
    if(novo === null) return;
    novo = novo.trim();
    if(!novo) return;
    av.name = novo;
    planIndepSalvar();
    planRender();
    planRefreshFundo();
    return;
  }
  var alvo = achaProjeto(fid, pi);
  var pl = alvo && planosDe(alvo.p)[k];
  if(!pl) return;
  var n = prompt('Novo nome do planejamento:', pl.name);
  if(n === null) return;
  n = n.trim();
  if(!n) return;
  pl.name = n;
  if(typeof pmSave === 'function') pmSave();
  planRender();
  planRefreshFundo();
}
window.planRenomear = planRenomear;

/* Atualiza a lista de planejamentos da página da pasta/empresa (por trás do
   modal), que não se redesenha sozinha quando o plano é editado por dentro
   do modal (renomear, reordenar/remover atividades etc.). Mantém a posição
   de rolagem para não "pular a tela" com o modal aberto. */
function planRefreshFundo(){
  try{
    if(planTodosAtivo && typeof planRenderTodos === 'function'){
      planRenderTodos(true);
      return;
    }
    if(typeof currentFolderId !== 'undefined' && currentFolderId && typeof openFolderPage === 'function'){
      openFolderPage(currentFolderId, true);
    }
  }catch(e){}
}
window.planRefreshFundo = planRefreshFundo;


/* ───────────────────────────────────────────────────────────────
   INDICE GERAL — de onde vem cada folha (empresa / projeto).
   Permite montar um planejamento com atividades de OUTRAS pastas,
   projetos e folhas, nao so as do projeto atual.
   ─────────────────────────────────────────────────────────────── */
function indiceFolhas(){
  var idx = {}, d = (typeof pmData !== 'undefined' && pmData) ? pmData : {};
  Object.keys(d).forEach(function(fid){
    if(fid === '__flat__') return;
    var f = d[fid];
    if(!f) return;
    (f.projects || []).forEach(function(pr, pidx){
      (pr.sheets || []).forEach(function(sid){
        idx[sid] = { fid:fid, pidx:pidx, empresa:f.name || '', projeto:pr.name || '' };
      });
    });
  });
  return idx;
}
window.indiceFolhas = indiceFolhas;

var buscaFid = '';
var buscaPidx = '';

function planOpcoesPastas(){
  var d = (typeof pmData !== 'undefined' && pmData) ? pmData : {};
  return Object.keys(d).filter(function(fid){ return fid !== '__flat__' && d[fid]; })
    .map(function(fid){ return { fid: fid, nome: d[fid].name || '(sem nome)' }; })
    .sort(function(a, b){ return a.nome.localeCompare(b.nome, 'pt-BR'); });
}

function planOpcoesProjetos(fid){
  var d = (typeof pmData !== 'undefined' && pmData) ? pmData : {};
  var f = d[fid];
  if(!f) return [];
  return (f.projects || []).map(function(pr, pidx){
    return { pidx: pidx, nome: pr.name || '(sem nome)' };
  }).sort(function(a, b){ return a.nome.localeCompare(b.nome, 'pt-BR'); });
}

function planOpcoesFolhas(fid, pidx){
  var d = (typeof pmData !== 'undefined' && pmData) ? pmData : {};
  var f = d[fid];
  var pr = f && f.projects && f.projects[pidx];
  if(!pr) return [];
  var a = planAtual();
  var jaTem = (a && a.pl.sheets) || [];
  var proprias = (a && a.p.sheets) || [];
  var lista = (typeof sheets !== 'undefined' ? sheets : []);
  return (pr.sheets || []).map(function(sid){
    return lista.filter(function(sh){ return sh && sh.id === sid; })[0];
  }).filter(function(sh){
    return sh && jaTem.indexOf(sh.id) === -1 && proprias.indexOf(sh.id) === -1;
  }).map(function(sh){
    var proc = (sh.header && sh.header.processo) || '';
    return { sid: sh.id, nome: sh.label + (proc ? ' \u2014 ' + proc : '') };
  });
}

function planBuscaHTML(){
  var pastas = planOpcoesPastas();
  var html = '<select id="plj-sel-pasta" class="plj-sel" onchange="planSelPasta(this.value)">'
           +   '<option value="">\uD83C\uDFE2 Selecione a pasta...</option>'
           +   pastas.map(function(p){
                 return '<option value="' + esc(p.fid) + '"' + (p.fid === buscaFid ? ' selected' : '') + '>'
                      + esc(p.nome) + '</option>';
               }).join('')
           + '</select>';

  var temPasta = !!buscaFid;
  var projetos = temPasta ? planOpcoesProjetos(buscaFid) : [];
  html += '<select id="plj-sel-projeto" class="plj-sel" onchange="planSelProjeto(this.value)"'
        +   (temPasta ? '' : ' disabled') + '>'
        +   '<option value="">\uD83D\uDCC1 Selecione o projeto...</option>'
        +   projetos.map(function(p){
              return '<option value="' + p.pidx + '"' + (String(p.pidx) === String(buscaPidx) ? ' selected' : '') + '>'
                   + esc(p.nome) + '</option>';
            }).join('')
        + '</select>';

  var temProjeto = temPasta && buscaPidx !== '';
  var folhas = temProjeto ? planOpcoesFolhas(buscaFid, buscaPidx) : [];
  html += '<select id="plj-sel-folha" class="plj-sel" onchange="planSelFolha(this.value)"'
        +   (temProjeto ? '' : ' disabled') + '>'
        +   '<option value="">\u2795 Selecione a folha para adicionar...</option>'
        +   folhas.map(function(f){
              return '<option value="' + esc(f.sid) + '">' + esc(f.nome) + '</option>';
            }).join('')
        + '</select>';

  if(temProjeto && !folhas.length){
    html += '<div class="plj-sel-dica">Nenhuma folha dispon\u00edvel para adicionar deste projeto.</div>';
  }
  return html;
}

function planSelPasta(fid){
  buscaFid = fid;
  buscaPidx = '';
  var host = document.getElementById('plj-cascata');
  if(host) host.innerHTML = planBuscaHTML();
}
window.planSelPasta = planSelPasta;

function planSelProjeto(pidx){
  buscaPidx = pidx;
  var host = document.getElementById('plj-cascata');
  if(host) host.innerHTML = planBuscaHTML();
}
window.planSelProjeto = planSelProjeto;

function planSelFolha(sid){
  if(!sid) return;
  planToggleFolha(sid);   // ja chama planRender(), que preserva buscaFid/buscaPidx
}
window.planSelFolha = planSelFolha;

/* ───────────────────────────────────────────────────────────────
   PAINEL DO PLANEJAMENTO
   ─────────────────────────────────────────────────────────────── */
var PL = { fid:null, pi:null, k:null, independente:false };

function planAbrir(fid, pi, k){
  if(typeof pmLoad === 'function') pmLoad();
  if(typeof bootSheetsOnce === 'function') bootSheetsOnce();
  PL = { fid:fid, pi:pi, k:k, independente:false };
  buscaFid = '';
  buscaPidx = '';
  var ov = document.getElementById('plj-overlay');
  if(ov) ov.classList.remove('hidden');
  planRender();
}
window.planAbrir = planAbrir;

function planAbrirIndependente(k){
  if(typeof pmLoad === 'function') pmLoad();
  if(typeof bootSheetsOnce === 'function') bootSheetsOnce();
  if(!planIndependentes()[k]) return;
  PL = { fid:null, pi:null, k:k, independente:true };
  buscaFid = '';
  buscaPidx = '';
  var ov = document.getElementById('plj-overlay');
  if(ov) ov.classList.remove('hidden');
  planRender();
}
window.planAbrirIndependente = planAbrirIndependente;

function planFechar(){
  var ov = document.getElementById('plj-overlay');
  if(ov) ov.classList.add('hidden');
  PL = { fid:null, pi:null, k:null, independente:false };
}
window.planFechar = planFechar;

function planFecharBg(e){
  if(e && e.target && e.target.id === 'plj-overlay') planFechar();
}
window.planFecharBg = planFecharBg;
document.addEventListener('keydown', function(e){
  if(e.key === 'Escape') planFechar();
});
window.PLJ_CTX = function(){ return PL; };

function planAtual(){
  if(PL && PL.independente){
    var av = planIndependentes()[PL.k];
    return av ? {
      f:{name:'Planejamentos independentes'},
      p:{name:'Sem vínculo com projeto',sheets:[]},
      pl:av,
      independente:true
    } : null;
  }
  var alvo = achaProjeto(PL.fid, PL.pi);
  if(!alvo) return null;
  var pl = planosDe(alvo.p)[PL.k];
  return pl ? { f:alvo.f, p:alvo.p, pl:pl, independente:false } : null;
}

function planToggleFolha(sid){
  var a = planAtual();
  if(!a) return;
  var arr = a.pl.sheets = a.pl.sheets || [];
  var i = arr.indexOf(sid);
  if(i === -1) arr.push(sid); else arr.splice(i, 1);
  planPersist(a);
  planRender();
  planRefreshFundo();
}
window.planToggleFolha = planToggleFolha;

function planTodas(marcar){
  var a = planAtual();
  if(!a) return;
  a.pl.sheets = marcar ? (a.independente ? (a.pl.sheets || []).slice() : (a.p.sheets || []).slice()) : [];
  planPersist(a);
  planRender();
  planRefreshFundo();
}
window.planTodas = planTodas;

/* ── ordenar / remover atividades já escolhidas no planejamento ── */
function planSheetMoveUp(sid){
  var a = planAtual();
  if(!a) return;
  var arr = a.pl.sheets = a.pl.sheets || [];
  var i = arr.indexOf(sid);
  if(i > 0){
    var tmp = arr[i - 1]; arr[i - 1] = arr[i]; arr[i] = tmp;
    planPersist(a);
    planRender();
    planRefreshFundo();
  }
}
window.planSheetMoveUp = planSheetMoveUp;

function planSheetMoveDown(sid){
  var a = planAtual();
  if(!a) return;
  var arr = a.pl.sheets = a.pl.sheets || [];
  var i = arr.indexOf(sid);
  if(i !== -1 && i < arr.length - 1){
    var tmp = arr[i + 1]; arr[i + 1] = arr[i]; arr[i] = tmp;
    planPersist(a);
    planRender();
    planRefreshFundo();
  }
}
window.planSheetMoveDown = planSheetMoveDown;

function planSheetRemove(sid){
  var a = planAtual();
  if(!a) return;
  var arr = a.pl.sheets || [];
  var i = arr.indexOf(sid);
  if(i !== -1){
    arr.splice(i, 1);
    if(a.pl.qtds) delete a.pl.qtds[sid];
    planPersist(a);
    planRender();
    planRefreshFundo();
  }
}
window.planSheetRemove = planSheetRemove;

/* Quantidade por atividade — no MTM o tempo apurado na folha é POR UNIDADE;
   aqui multiplicamos pelo tanto de peças/repetições que essa atividade
   representa dentro deste planejamento. Atualiza só o total da linha e os
   KPIs/recursos (não reconstrói a tabela, então o input não perde o foco). */
function planSheetSetQtd(sid, val){
  var a = planAtual();
  if(!a) return;
  if(!a.pl.qtds) a.pl.qtds = {};
  a.pl.qtds[sid] = val;
  planPersist(a);
  var sh = (typeof get === 'function') ? get(sid) : null;
  var m = (sh && typeof computeSheetMetrics === 'function') ? computeSheetMetrics(sh) : null;
  if(sh && m){
    var qtd = planQtdDe(a.pl, sid);
    var tpUnit = tempoPadrao(sh, m);
    var totEl = document.getElementById('plj-tot-' + sid);
    if(totEl) totEl.textContent = seg(tpUnit * qtd);
  }
  planRenderResumo();
  planRenderRecursosSum();
  planRefreshFundo();
}
window.planSheetSetQtd = planSheetSetQtd;

function planSetTakt(v){
  var a = planAtual();
  if(!a) return;
  a.pl.takt = v;
  planPersist(a);
  planRenderResumo();
  planRenderRecursosSum();
  planRefreshFundo();
}
window.planSetTakt = planSetTakt;

function planRenderResumo(){
  var a = planAtual();
  var el = document.getElementById('plj-resumo');
  if(!a || !el) return;
  var c = planCalcular(a.pl, a.p);

  var corSat = c.saturacao === 0 ? 'var(--text3)'
             : c.saturacao > 100 ? 'var(--red)'
             : c.saturacao >= 85 ? 'var(--green)'
             : c.saturacao >= 70 ? 'var(--yellow)'
             : 'var(--orange)';

  var html = ''
    + kpi('Atividades',   c.itens.length,            'var(--purple)', '')
    + kpi('Tempo Normal', seg(c.tn) + ' s',          'var(--text)',   minu(c.tn) + ' min')
    + kpi('TEMPO TOTAL',  seg(c.tp) + ' s',          'var(--green)',  minu(c.tp) + ' min')
    + kpi('Takt Time',    c.takt > 0 ? seg(c.takt) + ' s' : '—', 'var(--accent)', '')
    + kpi('Operadores',   c.takt > 0 ? c.ops : '—',  'var(--blue)',
          c.takt > 0 ? 'calculado: ' + c.opsExato.toFixed(2) : 'informe o takt')
    + kpi('Saturação',    c.takt > 0 ? c.saturacao.toFixed(1) + '%' : '—', corSat,
          c.takt > 0 ? (c.folga >= 0 ? 'folga ' + seg(c.folga) + ' s' : 'excede ' + seg(-c.folga) + ' s') : '');

  el.innerHTML = '<div class="plj-kpis">' + html + '</div>' + planVeredito(c);
}
window.planRenderResumo = planRenderResumo;

function kpi(rot, val, cor, sub){
  return '<div class="plj-kpi"><div class="plj-kpi-v" style="color:' + cor + '">' + val + '</div>'
       + '<div class="plj-kpi-r">' + rot + '</div>'
       + (sub ? '<div class="plj-kpi-s">' + sub + '</div>' : '') + '</div>';
}

function planVeredito(c){
  if(!c.itens.length) return '<div class="plj-vered plj-vered-off">Selecione as folhas para calcular o tempo total do projeto.</div>';
  if(!(c.takt > 0)) {
    return '<div class="plj-vered plj-vered-off">Informe o <b>Takt Time</b> acima para calcular '
         + 'quantos operadores o processo exige.</div>';
  }
  var txt, cls;
  if(c.tp <= c.takt){
    txt = 'O processo cabe no takt com <b>1 operador</b>. Sobram '
        + seg(c.takt - c.tp) + ' s por ciclo.';
    cls = 'ok';
  } else {
    txt = 'O tempo total excede o takt. São necessários <b>' + c.ops + ' operadores</b> '
        + '(' + c.opsExato.toFixed(2) + ' pelo cálculo). '
        + 'Saturação média de <b>' + c.saturacao.toFixed(1) + '%</b>'
        + (c.folga >= 0 ? ', com folga de ' + seg(c.folga) + ' s no conjunto.' : '.');
    cls = c.saturacao > 100 ? 'alerta' : 'ok';
  }
  return '<div class="plj-vered plj-vered-' + cls + '">' + txt + '</div>';
}

function planRender(){
  var a = planAtual();
  var box = document.getElementById('plj-body');
  if(!a || !box) return;

  var escolhidas = a.pl.sheets || [];
  var proprias   = a.p.sheets || [];
  var idx        = indiceFolhas();
  // folhas do projeto + as que vieram de outras pastas/projetos e ja estao no plano
  var ordem = proprias.slice();
  escolhidas.forEach(function(sid){ if(ordem.indexOf(sid) === -1) ordem.push(sid); });
  var todas = ordem.map(function(sid){
    return (typeof get === 'function') ? get(sid) : null;
  }).filter(Boolean);

  var tit = document.getElementById('plj-titulo');
  if(tit) tit.textContent = a.pl.name;
  var sub = document.getElementById('plj-sub');
  if(sub) sub.textContent = a.independente
    ? '◈ Planejamento independente · sem vínculo obrigatório com projeto'
    : '🏢 ' + a.f.name + '  ›  📁 ' + a.p.name;

  var html = ''
    + '<div class="plj-secao">'
    +   '<label class="plj-lbl">Takt Time do processo (segundos)</label>'
    +   '<input class="plj-takt" type="number" step="0.1" min="0" placeholder="ex.: 60" '
    +     'value="' + esc(a.pl.takt || '') + '" oninput="planSetTakt(this.value)">'
    +   '<small class="plj-hint">É o ritmo exigido pela demanda. Com ele o sistema calcula '
    +     'quantos operadores o tempo total exige.</small>'
    + '</div>'
    + '<div id="plj-resumo"></div>'
    + '<div class="plj-secao">'
    +   '<div class="plj-secao-hdr"><span>🔧 Recursos alocados (máquina / mão de obra)</span></div>'
    +   '<small class="plj-hint" style="display:block;margin-bottom:9px">Insira máquina, mão de obra ou os dois, '
    +     'cada um com sua dedicação. O cálculo parte de 1 recurso a 100%; conforme mais recursos entram, '
    +     'o tempo do processo reduz proporcionalmente.</small>'
    +   '<div class="plj-rec-add">'
    +     '<button class="plj-rec-btn maq" onclick="planRecursoAdd(\'maquina\')">🔧 + Máquina</button>'
    +     '<button class="plj-rec-btn" onclick="planRecursoAdd(\'operador\')">🧍 + Mão de obra</button>'
    +   '</div>'
    +   '<div id="plj-recursos-rows"></div>'
    +   '<div id="plj-recursos-sum"></div>'
    + '</div>'
    + '<div class="plj-secao">'
    +   '<div class="plj-secao-hdr">'
    +     '<span>Atividades que entram neste planejamento</span>'
    +     (a.independente ? '' : '<button class="plj-mini" onclick="planTodas(true)">Marcar todas</button>')
    +     '<button class="plj-mini" onclick="planTodas(false)">Limpar</button>'
    +   '</div>';

  // separa as ja escolhidas (na ORDEM do planejamento) das disponiveis p/ adicionar
  var selecionadas = escolhidas.map(function(sid){
    return (typeof get === 'function') ? get(sid) : null;
  }).filter(Boolean);
  var disponiveis = todas.filter(function(sh){ return escolhidas.indexOf(sh.id) === -1; });

  if(!selecionadas.length && !disponiveis.length){
    html += a.independente
      ? '<div class="plj-vazio">Este planejamento ainda não tem atividades.<br><small>Use os seletores abaixo para escolher empresa, projeto e folha.</small></div>'
      : '<div class="plj-vazio">Este projeto ainda não tem folhas MTM.<br><small>Crie folhas no editor: cada folha é uma atividade do processo.</small></div>';
  } else {
    if(selecionadas.length){
      html += '<table class="plj-tab plj-tab-sel"><thead><tr>'
            + '<th style="width:26px">#</th><th>Atividade (folha MTM)</th>'
            + '<th style="width:72px">Tempo unid. (s)</th><th style="width:62px">Qtd</th>'
            + '<th style="width:76px">Total (s)</th>'
            + '<th style="width:78px"></th>'
            + '</tr></thead><tbody>';
      selecionadas.forEach(function(sh, i){
        var m = (typeof computeSheetMetrics === 'function') ? computeSheetMetrics(sh) : null;
        var proc = (sh.header && sh.header.processo) || '';
        var tps = m ? tempoPadrao(sh, m) : 0;
        var qtd = planQtdDe(a.pl, sh.id);
        var deFora = proprias.indexOf(sh.id) === -1;
        var o = idx[sh.id];
        var origem = deFora
          ? '<span class="plj-fora">\uD83C\uDFE2 ' + esc(o ? (o.empresa + ' \u203A ' + o.projeto) : 'outro projeto') + '</span>'
          : '';
        html += '<tr class="on">'
          + '<td class="plj-num">' + (i + 1) + '</td>'
          + '<td><b>' + esc(sh.label) + '</b>' + origem
          +   (proc ? '<em>' + esc(proc) + '</em>' : '') + '</td>'
          + '<td class="num">' + (m ? seg(tps) : '—') + '</td>'
          + '<td class="num plj-qtd"><input type="number" min="0.01" step="1" value="' + esc(qtd) + '" '
          +   'onclick="event.stopPropagation()" oninput="planSheetSetQtd(\'' + sh.id + '\', this.value)"></td>'
          + '<td class="num" id="plj-tot-' + sh.id + '">' + (m ? seg(tps * qtd) : '—') + '</td>'
          + '<td class="plj-ord">'
          +   '<button class="plj-ord-btn" onclick="planSheetMoveUp(\'' + sh.id + '\')" '
          +     (i === 0 ? 'disabled' : '') + ' title="Subir">\u2191</button>'
          +   '<button class="plj-ord-btn" onclick="planSheetMoveDown(\'' + sh.id + '\')" '
          +     (i === selecionadas.length - 1 ? 'disabled' : '') + ' title="Descer">\u2193</button>'
          +   '<button class="plj-ord-btn plj-ord-del" onclick="planSheetRemove(\'' + sh.id + '\')" '
          +     'title="Remover do planejamento">\u2715</button>'
          + '</td>'
          + '</tr>';
      });
      html += '</tbody></table>';
    }
    if(disponiveis.length){
      html += '<div class="plj-add-hdr">' + (selecionadas.length ? 'Adicionar mais atividades' : 'Escolha as atividades') + '</div>'
            + '<table class="plj-tab"><tbody>';
      disponiveis.forEach(function(sh){
        var m = (typeof computeSheetMetrics === 'function') ? computeSheetMetrics(sh) : null;
        var proc = (sh.header && sh.header.processo) || '';
        var tps = m ? tempoPadrao(sh, m) : 0;
        var deFora = proprias.indexOf(sh.id) === -1;
        var o = idx[sh.id];
        var origem = deFora
          ? '<span class="plj-fora">\uD83C\uDFE2 ' + esc(o ? (o.empresa + ' \u203A ' + o.projeto) : 'outro projeto') + '</span>'
          : '';
        html += '<tr onclick="planToggleFolha(\'' + sh.id + '\')">'
          + '<td style="width:34px"><span class="plj-check"></span></td>'
          + '<td><b>' + esc(sh.label) + '</b>' + origem
          +   (proc ? '<em>' + esc(proc) + '</em>' : '') + '</td>'
          + '<td class="num" style="width:76px">' + (m ? (tps / 0.036).toFixed(0) : '—') + '</td>'
          + '<td class="num" style="width:82px">' + (m ? seg(tps) : '—') + '</td>'
          + '</tr>';
      });
      html += '</tbody></table>';
    }
  }
  html += '<div class="plj-busca">'
       +   '<label class="plj-lbl">' + (a.independente ? 'Selecionar atividade de qualquer empresa, projeto e folha' : 'Buscar atividade em outras pastas, projetos e folhas') + '</label>'
       +   '<div id="plj-cascata" class="plj-cascata">' + planBuscaHTML() + '</div>'
       + '</div>';
  html += '</div>';

  box.innerHTML = html;
  planRenderResumo();
  planRenderRecursos();
}
window.planRender = planRender;

// Relatório independente do escopo do editor: apenas as folhas deste plano.
function prepararPrintPlanejamento(){
  var a = planAtual(), box = document.getElementById('print-area');
  if(!a || !box) throw new Error('Planejamento indisponível.');
  var c = planCalcular(a.pl, a.p), idx = indiceFolhas();
  if(!c.itens.length || c.itens.length !== (a.pl.sheets || []).length){
    box.innerHTML = '';
    throw new Error('Selecione atividades válidas. Há folhas ausentes ou o planejamento está vazio.');
  }
  function n(v, d){ return Number(v).toLocaleString('pt-BR', {minimumFractionDigits:d == null ? 2 : d, maximumFractionDigits:d == null ? 2 : d}); }
  function row(label, value){ return '<tr><th>' + esc(label) + '</th><td>' + esc(value) + '</td></tr>'; }
  var r = c.recursos;
  var html = '<div class="pa-folha"><div class="pa-h1">Planejamento · ' + esc(a.p.name) + '</div>'
    + '<div class="pa-h2">' + esc(a.pl.name) + '</div><table class="pa-table"><tbody>'
    + row('Empresa', a.f.name) + row('Projeto', a.p.name)
    + row('Tipo', a.independente ? 'Independente' : 'Vinculado ao projeto')
    + row('Identificação', a.pl.id || '') + row('Data do planejamento', a.pl.date || 'Não informada')
    + row('Emissão', new Date().toLocaleString('pt-BR'))
    + row('Tempo normal total', n(c.tn) + ' s')
    + row('TEMPO TOTAL DO PLANEJAMENTO', n(c.tp) + ' s | ' + n(c.tp/60) + ' min | ' + n(c.tp/3600,4) + ' h')
    + row('Takt Time', c.takt > 0 ? n(c.takt) + ' s' : 'Não informado')
    + row('Operadores calculados', c.takt > 0 ? c.ops + ' (exato: ' + n(c.opsExato) + ')' : 'Não calculado: sem takt')
    + row('Saturação média', c.takt > 0 ? n(c.saturacao) + '%' : 'Não calculada: sem takt')
    + row('Folga no conjunto', c.takt > 0 ? n(c.folga) + ' s' : 'Não calculada: sem takt')
    + row('Capacidade teórica sem recursos', n(c.pecasHora,0) + ' unidades do planejamento/h')
    + '</tbody></table><div class="pa-h2">Atividades e memória de cálculo</div>'
    + '<table class="pa-table"><thead><tr><th>#</th><th>Folha MTM / Processo / Origem</th><th>Tempo padrão unit. (s)</th><th>Qtd.</th><th>Subtotal (s)</th></tr></thead><tbody>';
  c.itens.forEach(function(it, i){
    var o = idx[it.sid];
    html += '<tr><td>' + (i+1) + '</td><td><b>' + esc(it.label) + '</b><br>' + esc(it.processo)
      + '<br>' + esc(o ? o.empresa + ' › ' + o.projeto : 'Origem não vinculada')
      + '</td><td class="num">' + n(it.tpUnit,4) + '</td><td class="num">' + esc(it.qtd)
      + '</td><td class="num">' + n(it.tpTotal,4) + '</td></tr>';
  });
  html += '<tr class="total-row"><td colspan="4">TOTAL</td><td class="num">' + n(c.tp,4)
    + '</td></tr></tbody></table><p class="pa-note">Total = soma do tempo padrão de cada folha × quantidade no planejamento. '
    + 'Cálculo sem arredondamento intermediário. Os anexos apresentam uma execução de cada folha, na ordem acima.</p>'
    + '<div class="pa-h2">Recursos alocados</div><table class="pa-table"><thead><tr><th>Tipo</th><th>Nome</th><th>Dedicação (%)</th></tr></thead><tbody>';
  r.lista.forEach(function(rec){
    html += '<tr><td>' + (rec.tipo === 'maquina' ? 'Máquina' : 'Mão de obra') + '</td><td>'
      + esc(rec.label || 'Não informado') + '</td><td>' + esc(rec.dedicacao) + '</td></tr>';
  });
  if(!r.lista.length) html += '<tr><td colspan="3">Nenhum recurso informado: padrão de 1 recurso a 100%.</td></tr>';
  html += '</tbody></table><table class="pa-table"><tbody>'
    + row('Fator de recursos', n(r.fator) + '×')
    + row('Tempo efetivo simulado', r.fator > 0 ? n(r.tpEfetivo) + ' s | ' + n(r.tpEfetivo/60) + ' min' : 'Indisponível: dedicação total zero')
    + row('Capacidade teórica com recursos', r.fator > 0 ? n(r.pecasHoraEfetiva,0) + ' unidades do planejamento/h' : 'Indisponível: dedicação total zero')
    + row('Comparação com takt', c.takt > 0 && r.fator > 0 ? (r.tpEfetivo <= c.takt ? 'Atende na simulação' : 'Excede na simulação') : 'Não calculada')
    + '</tbody></table><p class="pa-note">Simulação existente: tempo total ÷ soma das dedicações/100. '
    + 'Pressupõe divisão proporcional do trabalho; a combinação de máquinas e pessoas não comprova paralelismo real.</p>'
    + '<div class="pa-h2">Composição do tempo normal (com quantidades)</div><table class="pa-table"><tbody>'
    + row('Agrega valor', n(c.va*0.036) + ' s') + row('Não agrega valor', n(c.nva*0.036) + ' s')
    + row('Necessário', n(c.nnva*0.036) + ' s') + row('Não classificado', n(c.unc*0.036) + ' s')
    + '</tbody></table></div>';
  var folhasRelatorio = c.itens.map(function(it){
    var sh = get(it.sid), origem = idx[it.sid], h = sh.header || {};
    // O vínculo real da folha pode não estar preenchido no cabeçalho antigo.
    // Completa apenas a cópia impressa, preservando os dados da análise.
    return Object.assign({}, sh, {header:Object.assign({}, h, {
      empresa:origem && origem.empresa || h.empresa || a.f.name,
      projeto:origem && origem.projeto || h.projeto || (a.independente ? 'Sem vínculo com projeto' : a.p.name)
    })});
  });
  prepararPrint(folhasRelatorio);
  var anexo = 0;
  box.innerHTML = box.innerHTML.replace(/<div class="pa-h1">/g, function(){
    var folha = folhasRelatorio[anexo++];
    return '<div class="pa-h2">Relatório final · ' + esc(folha.header.projeto) + '</div>'
      + '<div class="pa-note">Integra o planejamento: <b>' + esc(a.pl.name) + '</b>'
      + ' · Projeto do planejamento: ' + esc(a.p.name) + '</div><div class="pa-h1">';
  });
  box.innerHTML = html + box.innerHTML;
  mtmDefinirNomePDF('Planejamento', a.independente ? a.pl.name : a.p.name);
  return c;
}
window.prepararPrintPlanejamento = prepararPrintPlanejamento;
window.planImprimir = function(){
  try{
    prepararPrintPlanejamento();
    window._mtmPrintMode = 'planejamento';
    window.print();
  }catch(e){
    window._mtmPrintMode = 'folhas';
    mtmRestaurarTituloPDF();
    alert('Não foi possível imprimir: ' + e.message);
  }
};

})();
