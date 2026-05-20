/* ============================================================================
   firebase-mtm.js — Integração Firebase do MTM (MODO ABERTO COMPARTILHADO)
   ----------------------------------------------------------------------------
   • Sem tela de login: usa Firebase Anonymous Auth (transparente pro usuário)
   • Workspace ÚNICO compartilhado entre todos os dispositivos/usuários
   • Quem abrir o link vê e edita tudo em tempo real
   • localStorage continua como cache offline
   ============================================================================ */

import { initializeApp }            from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInAnonymously
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, deleteDoc,
  collection, onSnapshot, getDocs,
  serverTimestamp, writeBatch
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

const cfg = window.FIREBASE_CONFIG;

function bootDirectFallback(reason){
  console.warn('[MTM·FB] Modo offline:', reason);
  const tryStart = ()=>{
    if(typeof window.startDirectMtmApp === 'function'){
      window.startDirectMtmApp();
    } else {
      setTimeout(tryStart, 100);
    }
  };
  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', tryStart);
  } else {
    tryStart();
  }
}

const configInvalid = !cfg || !cfg.apiKey
  || cfg.apiKey.includes('COLE_AQUI')
  || cfg.projectId === 'SEU_PROJETO';

if(configInvalid){
  bootDirectFallback('window.FIREBASE_CONFIG ausente ou placeholder.');
  document.addEventListener('DOMContentLoaded', ()=>{
    setTimeout(()=>{
      if(typeof showToast === 'function'){
        showToast('⚠️ Firebase não configurado — modo offline (só este dispositivo).', true);
      }
    }, 1200);
  });
  throw new Error('Firebase config ausente');
}

const app  = initializeApp(cfg);
const auth = getAuth(app);
const db   = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

const state = {
  user:     null,
  unsubs:   [],
  pending:  0,
  ready:    false,
  applying: false
};

const C_SHEETS   = 'sheets';
const C_PROJECTS = 'projects';
const C_LOGOS    = 'logos';

function setStatus(kind, label){
  const badge = document.getElementById('mtm-sync-badge');
  if(!badge) return;
  badge.dataset.kind = kind;
  const lbl = badge.querySelector('.sync-label');
  if(lbl) lbl.textContent = label;
}
function bumpPending(delta){
  state.pending = Math.max(0, state.pending + delta);
  if(state.pending > 0)      setStatus('syncing', 'Sincronizando…');
  else if(navigator.onLine)  setStatus('online',  'Sincronizado');
  else                       setStatus('offline', 'Offline');
}
window.addEventListener('online',  ()=> bumpPending(0));
window.addEventListener('offline', ()=> setStatus('offline', 'Offline'));

function toast(msg, isErr){
  if(typeof showToast === 'function') return showToast(msg, !!isErr);
  console[isErr?'error':'log']('[MTM·FB]', msg);
}

function renderStatusBadge(){
  const slot = document.getElementById('fb-user-slot');
  if(!slot) return;
  slot.innerHTML = '<div class="fb-sync-badge" id="mtm-sync-badge" data-kind="syncing" title="Status de sincronização"><span class="sync-dot"></span><span class="sync-label">Conectando…</span></div>';
  bumpPending(0);
}

let _firstSheets   = true;
let _firstProjects = true;
let _firstLogos    = true;

function applySheetsSnapshot(snap){
  state.applying = true;
  try{
    const remote = {};
    snap.forEach(d => { remote[d.id] = d.data(); });
    const remoteCount = Object.keys(remote).length;

    if(_firstSheets && remoteCount === 0){
      _firstSheets = false;
      const local = (window.sheets || []).filter(s => s && s.id);
      if(local.length){
        console.log('[MTM·FB] Migrando ' + local.length + ' folha(s)...');
        toast('🚀 Enviando suas folhas para a nuvem...');
        state.applying = false;
        if(typeof window.saveSheets === 'function') window.saveSheets();
        finishInitialLoadIfReady();
        return;
      }
    }
    _firstSheets = false;

    const arr = Object.values(remote)
      .sort((a,b) => (a.order||0) - (b.order||0))
      .map(s => ({
        id:     s.id,
        label:  s.label || 'FOLHA',
        header: s.header || {},
        book:   s.book   || '',
        fadiga: s.fadiga || null,
        rows:   Array.isArray(s.rows) ? s.rows : []
      }));

    if(typeof window.sheets !== 'undefined'){
      window.sheets = arr;
    }
    try{ localStorage.setItem('mtm_sheets_v1', JSON.stringify(arr)); }catch(e){}
    rerenderSheets();
  } finally {
    state.applying = false;
    finishInitialLoadIfReady();
  }
}

function applyProjectsSnapshot(snap){
  state.applying = true;
  try{
    const obj = {};
    snap.forEach(d => { obj[d.id] = d.data(); });
    const remoteCount = Object.keys(obj).length;

    if(_firstProjects && remoteCount === 0){
      _firstProjects = false;
      const local = window.pmData || {};
      if(Object.keys(local).length){
        console.log('[MTM·FB] Migrando ' + Object.keys(local).length + ' empresa(s)...');
        state.applying = false;
        if(typeof window.pmSave === 'function') window.pmSave();
        finishInitialLoadIfReady();
        return;
      }
    }
    _firstProjects = false;

    if(typeof window.pmData !== 'undefined'){
      window.pmData = obj;
    }
    try{ localStorage.setItem('pmgr_v3', JSON.stringify(obj)); }catch(e){}

    if(typeof window.pmRefreshIfOpen === 'function') window.pmRefreshIfOpen();
    else if(typeof window.pmView === 'function' && document.getElementById('pm-overlay')
        && document.getElementById('pm-overlay').classList.contains('open')){
      try{ window.pmView('folders'); }catch(e){}
    }
  } finally {
    state.applying = false;
    finishInitialLoadIfReady();
  }
}

function applyLogosSnapshot(snap){
  state.applying = true;
  try{
    const obj = {};
    snap.forEach(d => { obj[d.id] = d.data().dataUrl || ''; });
    const remoteCount = Object.keys(obj).length;

    if(_firstLogos && remoteCount === 0){
      _firstLogos = false;
      let localLogos = {};
      try{ localLogos = JSON.parse(localStorage.getItem('mtm_client_logos_v1') || '{}') || {}; }catch(e){}
      if(Object.keys(localLogos).length){
        console.log('[MTM·FB] Migrando ' + Object.keys(localLogos).length + ' logo(s)...');
        state.applying = false;
        if(typeof window.dbSaveClientLogos === 'function') window.dbSaveClientLogos(localLogos);
        finishInitialLoadIfReady();
        return;
      }
    }
    _firstLogos = false;

    try{ localStorage.setItem('mtm_client_logos_v1', JSON.stringify(obj)); }catch(e){}
  } finally {
    state.applying = false;
    finishInitialLoadIfReady();
  }
}

function rerenderSheets(){
  document.querySelectorAll('.folha-content').forEach(el => {
    const id = el.id.replace(/^c-/, '');
    if(!window.sheets.find(s => s.id === id)) el.remove();
  });
  window.sheets.forEach(s => {
    if(!document.getElementById('c-' + s.id) && typeof window.renderContent === 'function'){
      try{ window.renderContent(s.id); }catch(e){ console.warn(e); }
    } else if(typeof window.recalc === 'function'){
      try{ window.recalc(s.id); }catch(e){}
    }
  });
  if(typeof window.renderTabs === 'function') window.renderTabs();
  if(!window.activeId && window.sheets[0] && typeof window.setActive === 'function'){
    window.setActive(window.sheets[0].id);
  }
}

let _initialLoadDone = false;
function finishInitialLoadIfReady(){
  if(_initialLoadDone) return;
  _initialLoadDone = true;
  state.ready = true;
  bumpPending(0);
  if(window.sheets && window.sheets.length === 0 && typeof window.addSheet === 'function'){
    window.addSheet('FOLHA 1');
  }
}

const writeQueue = {
  sheets:   new Map(),
  projects: new Map(),
  logos:    new Map(),
  flushTimer: null
};

function scheduleFlush(){
  clearTimeout(writeQueue.flushTimer);
  writeQueue.flushTimer = setTimeout(flushWrites, 400);
}

async function flushWrites(){
  if(!state.user) return;
  if(state.applying) return;

  const batch = writeBatch(db);
  let count = 0;

  writeQueue.sheets.forEach((payload, id) => {
    const ref = doc(db, C_SHEETS, id);
    batch.set(ref, { ...payload, updatedAt: serverTimestamp(), updatedBy: state.user.uid });
    count++;
  });
  writeQueue.sheets.clear();

  writeQueue.projects.forEach((payload, id) => {
    const ref = doc(db, C_PROJECTS, id);
    batch.set(ref, { ...payload, updatedAt: serverTimestamp(), updatedBy: state.user.uid });
    count++;
  });
  writeQueue.projects.clear();

  writeQueue.logos.forEach((dataUrl, client) => {
    const ref = doc(db, C_LOGOS, sanitizeKey(client));
    batch.set(ref, { client, dataUrl, updatedAt: serverTimestamp(), updatedBy: state.user.uid });
    count++;
  });
  writeQueue.logos.clear();

  if(!count) return;
  bumpPending(+1);
  try{
    await batch.commit();
  }catch(e){
    console.warn('[MTM·FB] batch falhou', e);
    toast('Erro de sincronização: ' + e.message, true);
  }finally{
    bumpPending(-1);
  }
}

function sanitizeKey(s){
  return String(s||'').replace(/[\/\\.#$\[\]]/g, '_').slice(0,150) || '_';
}

async function syncDeletions(coll, localIds){
  if(state.applying) return;
  try{
    const snap = await getDocs(collection(db, coll));
    const remoteIds = new Set(); snap.forEach(d => remoteIds.add(d.id));
    const toDelete = [];
    remoteIds.forEach(id => { if(!localIds.has(id)) toDelete.push(id); });
    if(toDelete.length){
      const batch = writeBatch(db);
      toDelete.forEach(id => batch.delete(doc(db, coll, id)));
      await batch.commit();
    }
  }catch(e){ console.warn('syncDeletions ' + coll, e); }
}

function patchAppFunctions(){
  if(typeof window.saveSheets === 'function' && !window.saveSheets.__fbPatched){
    const orig = window.saveSheets;
    window.saveSheets = function(){
      orig.apply(this, arguments);
      if(!state.user || state.applying) return;
      (window.sheets||[]).forEach((s, i) => {
        writeQueue.sheets.set(s.id, {
          id: s.id,
          label: s.label || '',
          header: s.header || {},
          book: s.book || '',
          fadiga: s.fadiga || null,
          rows: Array.isArray(s.rows) ? s.rows.map(r => ({
            id: r.id, desc: r.desc||'', agrega: r.agrega||'', code: r.code||'',
            tmu: String(r.tmu||''), q: String(r.q||''), f: String(r.f||''),
            ttmu: Number(r.ttmu)||0, tsec: Number(r.tsec)||0
          })) : [],
          order: i
        });
      });
      scheduleFlush();
      syncDeletions(C_SHEETS, new Set((window.sheets||[]).map(s => s.id)));
    };
    window.saveSheets.__fbPatched = true;
  }

  if(typeof window.pmSave === 'function' && !window.pmSave.__fbPatched){
    const orig = window.pmSave;
    window.pmSave = function(){
      orig.apply(this, arguments);
      if(!state.user || state.applying) return;
      const data = window.pmData || {};
      Object.keys(data).forEach(fid => {
        const folder = data[fid];
        writeQueue.projects.set(fid, {
          id: fid,
          name: folder.name || '',
          logo: folder.logo || null,
          projects: Array.isArray(folder.projects) ? folder.projects : []
        });
      });
      scheduleFlush();
      syncDeletions(C_PROJECTS, new Set(Object.keys(data)));
    };
    window.pmSave.__fbPatched = true;
  }

  if(typeof window.dbSaveClientLogos === 'function' && !window.dbSaveClientLogos.__fbPatched){
    const orig = window.dbSaveClientLogos;
    window.dbSaveClientLogos = function(obj){
      orig.apply(this, arguments);
      if(!state.user || state.applying) return;
      const o = obj || {};
      Object.keys(o).forEach(client => {
        writeQueue.logos.set(client, o[client] || '');
      });
      scheduleFlush();
    };
    window.dbSaveClientLogos.__fbPatched = true;
  }
}

function attachListeners(){
  cleanupListeners();
  _firstSheets = _firstProjects = _firstLogos = true;
  _initialLoadDone = false;

  state.unsubs.push(onSnapshot(collection(db, C_SHEETS),
    snap => applySheetsSnapshot(snap),
    err  => { console.error('listener sheets:', err); toast('Erro de conexão: ' + err.message, true); }
  ));
  state.unsubs.push(onSnapshot(collection(db, C_PROJECTS),
    snap => applyProjectsSnapshot(snap),
    err  => console.error('listener projects:', err)
  ));
  state.unsubs.push(onSnapshot(collection(db, C_LOGOS),
    snap => applyLogosSnapshot(snap),
    err  => console.error('listener logos:', err)
  ));

  setStatus('syncing', 'Carregando…');
}

function cleanupListeners(){
  state.unsubs.forEach(u => { try{ u(); }catch(e){} });
  state.unsubs = [];
}

function waitForDom(){
  return new Promise(res => {
    if(document.readyState !== 'loading') res();
    else document.addEventListener('DOMContentLoaded', res);
  });
}

onAuthStateChanged(auth, async user => {
  await waitForDom();

  if(!user){
    try{
      await signInAnonymously(auth);
    }catch(e){
      console.error('[MTM·FB] Anonymous auth falhou:', e);
      toast('⚠️ Falha de conexão. Modo offline ativado.', true);
      bootDirectFallback(e.message);
    }
    return;
  }

  state.user = user;
  console.log('[MTM·FB] Autenticado (anônimo) — uid:', user.uid);

  if(typeof window.startDirectMtmApp === 'function'){
    window.startDirectMtmApp();
  } else {
    const tryBoot = setInterval(()=>{
      if(typeof window.startDirectMtmApp === 'function'){
        clearInterval(tryBoot);
        window.startDirectMtmApp();
      }
    }, 80);
  }

  if(typeof window.saveSheets === 'function'){
    patchAppFunctions();
  } else {
    const wait = setInterval(()=>{
      if(typeof window.saveSheets === 'function'){
        clearInterval(wait);
        patchAppFunctions();
      }
    }, 100);
  }

  renderStatusBadge();
  attachListeners();
});

document.addEventListener('DOMContentLoaded', ()=>{
  ['fb-auth-screen', 'fb-workspace-screen'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.remove();
  });
  document.body.classList.remove('fb-locked');
});

window.MTMFB = { state, db, auth, flushWrites };
console.log('[MTM·FB] módulo carregado (modo anônimo compartilhado).');
