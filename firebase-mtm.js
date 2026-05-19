/* ============================================================================
   firebase-mtm.js — Integração Firebase para o MTM
   Autor: integração feita para o app Engº Ivan Carlos Antoneli
   ----------------------------------------------------------------------------
   Recursos:
   • Firebase Auth (email/senha + Google) — equipe com login individual
   • Firestore real-time — folhas, projetos, empresas, logos, notas
   • Workspaces compartilhados (equipe entra por código de convite)
   • Offline-first (persistência nativa do Firestore + cache localStorage)
   • Last-write-wins com server timestamps
   • Sem quebrar nada: localStorage continua sendo populado (cache)
   ============================================================================ */

import { initializeApp }            from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  GoogleAuthProvider, signInWithPopup, signOut, updateProfile
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc,
  collection, onSnapshot, query, where,
  serverTimestamp, writeBatch, runTransaction
} from 'https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js';

/* ----------------------------------------------------------------------------
   CONFIG — preencha window.FIREBASE_CONFIG no index.html antes deste script
---------------------------------------------------------------------------- */
const cfg = window.FIREBASE_CONFIG;

function bootDirectFallback(reason){
  console.warn('[MTM·FB] Caindo no modo offline (localStorage puro):', reason);
  // Espera DOM + app pronto
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

// Detecta config ausente OU ainda com placeholder
const configInvalid = !cfg || !cfg.apiKey
  || cfg.apiKey.includes('COLE_AQUI')
  || cfg.projectId === 'SEU_PROJETO';

if(configInvalid){
  bootDirectFallback('window.FIREBASE_CONFIG ausente ou ainda com placeholder. Veja README-setup.md.');
  // Mostra aviso amigável após o DOM montar
  document.addEventListener('DOMContentLoaded', ()=>{
    setTimeout(()=>{
      if(typeof showToast === 'function'){
        showToast('⚠️ Firebase não configurado — rodando em modo offline (só este dispositivo). Edite o index.html (window.FIREBASE_CONFIG) ou veja README-setup.md.', true);
      }
    }, 1200);
  });
  throw new Error('Firebase config ausente ou placeholder');
}

const app  = initializeApp(cfg);
const auth = getAuth(app);
const db   = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

/* ----------------------------------------------------------------------------
   ESTADO GLOBAL DO MÓDULO
---------------------------------------------------------------------------- */
const state = {
  user:        null,    // firebase user
  workspaceId: null,    // workspace ativo
  workspace:   null,    // { name, ownerUid, members:{uid:{role,name,email}} }
  unsubs:      [],      // listeners ativos pra limpar no logout/troca de ws
  pending:     0,       // contador de escritas pendentes (status indicator)
  ready:       false,   // primeiros snapshots já chegaram
  applying:    false    // estamos aplicando dados remotos → evita eco
};

/* Chaves locais auxiliares */
const LS_LAST_WS = 'mtm_fb_last_workspace';
const LS_USER_WS = 'mtm_fb_user_workspaces';   // map uid → [{id,name}]

/* ----------------------------------------------------------------------------
   STATUS INDICATOR (chamado por updateSyncBadge)
---------------------------------------------------------------------------- */
function setStatus(kind, label){
  const badge = document.getElementById('mtm-sync-badge');
  if(!badge) return;
  badge.dataset.kind = kind; // 'online' | 'syncing' | 'offline' | 'error'
  badge.querySelector('.sync-label').textContent = label;
}
function bumpPending(delta){
  state.pending = Math.max(0, state.pending + delta);
  if(state.pending > 0)      setStatus('syncing', 'Sincronizando…');
  else if(navigator.onLine)  setStatus('online',  'Sincronizado');
  else                       setStatus('offline', 'Offline');
}
window.addEventListener('online',  ()=> bumpPending(0));
window.addEventListener('offline', ()=> setStatus('offline', 'Offline'));

/* ----------------------------------------------------------------------------
   TOAST helper (usa o do app, se existir)
---------------------------------------------------------------------------- */
function toast(msg, isErr){
  if(typeof showToast === 'function') return showToast(msg, !!isErr);
  console[isErr?'error':'log']('[MTM·FB]', msg);
}

/* ----------------------------------------------------------------------------
   AUTH UI — controla a tela de login (#fb-auth-screen no index.html)
---------------------------------------------------------------------------- */
function showAuthUI(){
  const el = document.getElementById('fb-auth-screen');
  if(el) el.classList.add('show');
  // Esconde a app
  document.body.classList.add('fb-locked');
}
function hideAuthUI(){
  const el = document.getElementById('fb-auth-screen');
  if(el) el.classList.remove('show');
  document.body.classList.remove('fb-locked');
}
function showWorkspaceUI(){
  const el = document.getElementById('fb-workspace-screen');
  if(el) el.classList.add('show');
  document.body.classList.add('fb-locked');
}
function hideWorkspaceUI(){
  const el = document.getElementById('fb-workspace-screen');
  if(el) el.classList.remove('show');
  document.body.classList.remove('fb-locked');
}

/* ----------------------------------------------------------------------------
   AUTH ACTIONS — expostas em window pro HTML chamar
---------------------------------------------------------------------------- */
window.fbLogin = async function(){
  const email = document.getElementById('fb-l-email').value.trim();
  const pass  = document.getElementById('fb-l-pass').value;
  const err   = document.getElementById('fb-l-err');
  err.textContent = '';
  if(!email || !pass){ err.textContent = '⚠️ Preencha e-mail e senha.'; return; }
  try{
    await signInWithEmailAndPassword(auth, email, pass);
  }catch(e){
    err.textContent = friendlyAuthError(e);
  }
};

window.fbRegister = async function(){
  const name  = document.getElementById('fb-r-name').value.trim();
  const email = document.getElementById('fb-r-email').value.trim();
  const pass  = document.getElementById('fb-r-pass').value;
  const err   = document.getElementById('fb-r-err');
  err.textContent = '';
  if(!name || !email || !pass){ err.textContent = '⚠️ Preencha todos os campos.'; return; }
  if(pass.length < 6){ err.textContent = '⚠️ Senha precisa ter ao menos 6 caracteres.'; return; }
  try{
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
  }catch(e){
    err.textContent = friendlyAuthError(e);
  }
};

window.fbLoginGoogle = async function(){
  try{
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }catch(e){
    const err = document.getElementById('fb-l-err');
    if(err) err.textContent = friendlyAuthError(e);
  }
};

window.fbLogout = async function(){
  if(!confirm('Sair da conta?')) return;
  try{ await signOut(auth); }catch(e){ toast('Erro ao sair: ' + e.message, true); }
};

window.fbSwitchTab = function(tab){
  document.getElementById('fb-panel-login'   ).classList.toggle('active', tab==='login');
  document.getElementById('fb-panel-register').classList.toggle('active', tab==='register');
  document.getElementById('fb-tab-login'   ).classList.toggle('active', tab==='login');
  document.getElementById('fb-tab-register').classList.toggle('active', tab==='register');
};

function friendlyAuthError(e){
  const m = (e && e.code) || '';
  if(m.includes('invalid-email'))         return '✕ E-mail inválido.';
  if(m.includes('email-already-in-use'))  return '✕ Esse e-mail já está cadastrado.';
  if(m.includes('weak-password'))         return '✕ Senha muito fraca (mín. 6 caracteres).';
  if(m.includes('user-not-found'))        return '✕ Usuário não encontrado.';
  if(m.includes('wrong-password') ||
     m.includes('invalid-credential'))    return '✕ E-mail ou senha incorretos.';
  if(m.includes('too-many-requests'))     return '⚠️ Muitas tentativas. Tente novamente em alguns minutos.';
  if(m.includes('network-request-failed'))return '⚠️ Sem conexão. Verifique sua internet.';
  return '✕ ' + ((e && e.message) || 'Erro desconhecido.');
}

/* ----------------------------------------------------------------------------
   WORKSPACE ACTIONS
---------------------------------------------------------------------------- */
window.fbCreateWorkspace = async function(){
  const name = document.getElementById('fb-ws-name').value.trim();
  const err  = document.getElementById('fb-ws-err');
  err.textContent = '';
  if(!name){ err.textContent = '⚠️ Dê um nome ao espaço de trabalho.'; return; }
  try{
    const wsRef = doc(collection(db, 'workspaces'));
    const code  = makeInviteCode();
    await setDoc(wsRef, {
      name,
      ownerUid: state.user.uid,
      inviteCode: code,
      createdAt: serverTimestamp(),
      members: {
        [state.user.uid]: {
          role:  'owner',
          name:  state.user.displayName || state.user.email,
          email: state.user.email,
          joinedAt: Date.now()
        }
      }
    });
    rememberWorkspace(wsRef.id, name);
    await enterWorkspace(wsRef.id);
    toast('🎉 Workspace criado! Código de convite: ' + code);
  }catch(e){
    err.textContent = '✕ ' + e.message;
  }
};

window.fbJoinWorkspace = async function(){
  const code = document.getElementById('fb-ws-code').value.trim().toUpperCase();
  const err  = document.getElementById('fb-ws-err');
  err.textContent = '';
  if(!code){ err.textContent = '⚠️ Informe o código de convite.'; return; }
  try{
    // Acha workspace por inviteCode
    const { getDocs } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js');
    const q = query(collection(db, 'workspaces'), where('inviteCode', '==', code));
    const snap = await getDocs(q);
    if(snap.empty){ err.textContent = '✕ Código não encontrado.'; return; }
    const wsDoc = snap.docs[0];
    const wsId  = wsDoc.id;
    const data  = wsDoc.data();
    // Adiciona como membro
    await updateDoc(wsDoc.ref, {
      [`members.${state.user.uid}`]: {
        role: 'editor',
        name:  state.user.displayName || state.user.email,
        email: state.user.email,
        joinedAt: Date.now()
      }
    });
    rememberWorkspace(wsId, data.name);
    await enterWorkspace(wsId);
    toast('✅ Entrou em "' + data.name + '"');
  }catch(e){
    err.textContent = '✕ ' + e.message;
  }
};

window.fbSwitchWorkspace = async function(wsId){
  if(wsId === state.workspaceId) return;
  await enterWorkspace(wsId);
  document.getElementById('fb-user-menu').classList.remove('open');
};

window.fbShowInviteCode = function(){
  if(!state.workspace) return;
  const code = state.workspace.inviteCode;
  const name = state.workspace.name;
  alert('Workspace: ' + name + '\n\nCódigo de convite:\n\n  ' + code + '\n\nCompartilhe com seu time. Eles podem entrar em "Trocar workspace → Entrar com código".');
};

window.fbOpenWorkspaceScreen = function(){
  // Permite trocar de workspace sem deslogar
  cleanupListeners();
  state.workspaceId = null;
  state.workspace   = null;
  localStorage.removeItem(LS_LAST_WS);
  renderUserMenu();
  showWorkspaceUI();
  buildWorkspaceList();
};

function makeInviteCode(){
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for(let i=0;i<6;i++) s += A[Math.floor(Math.random()*A.length)];
  return s;
}

function rememberWorkspace(id, name){
  const uid = state.user.uid;
  let map = {};
  try{ map = JSON.parse(localStorage.getItem(LS_USER_WS) || '{}'); }catch(e){}
  if(!map[uid]) map[uid] = [];
  if(!map[uid].find(w => w.id === id)){
    map[uid].push({ id, name });
    localStorage.setItem(LS_USER_WS, JSON.stringify(map));
  }
}

function getRememberedWorkspaces(){
  const uid = state.user && state.user.uid;
  if(!uid) return [];
  try{ return (JSON.parse(localStorage.getItem(LS_USER_WS) || '{}'))[uid] || []; }
  catch(e){ return []; }
}

async function buildWorkspaceList(){
  const list = document.getElementById('fb-ws-list');
  if(!list) return;
  list.innerHTML = '';
  const remembered = getRememberedWorkspaces();
  if(!remembered.length){
    list.innerHTML = '<div class="fb-ws-empty">Você ainda não pertence a nenhum workspace. Crie um abaixo, ou entre com um código.</div>';
    return;
  }
  // Verifica cada um
  for(const w of remembered){
    try{
      const wd = await getDoc(doc(db, 'workspaces', w.id));
      if(!wd.exists()) continue;
      const data = wd.data();
      if(!data.members || !data.members[state.user.uid]) continue;
      const role = data.members[state.user.uid].role;
      const memberCount = Object.keys(data.members||{}).length;
      const row = document.createElement('div');
      row.className = 'fb-ws-item';
      row.innerHTML = `
        <div class="fb-ws-info">
          <div class="fb-ws-title">${escapeHtml(data.name)}</div>
          <div class="fb-ws-meta">${memberCount} membro(s) · ${role}</div>
        </div>
        <button class="fb-btn fb-btn-primary" data-wsid="${w.id}">Abrir</button>
      `;
      row.querySelector('button').onclick = ()=> enterWorkspace(w.id);
      list.appendChild(row);
    }catch(e){ console.warn('ws check falhou', w, e); }
  }
}

/* ----------------------------------------------------------------------------
   ENTER WORKSPACE — instala todos os listeners em tempo real
---------------------------------------------------------------------------- */
async function enterWorkspace(wsId){
  cleanupListeners();
  state.ready = false;
  state.workspaceId = wsId;
  _firstSheetsSnapshot   = true;
  _firstProjectsSnapshot = true;
  _firstLogosSnapshot    = true;
  _initialLoadDone       = false;
  localStorage.setItem(LS_LAST_WS, wsId);

  // Carrega meta do workspace
  const wsRef  = doc(db, 'workspaces', wsId);
  const wsSnap = await getDoc(wsRef);
  if(!wsSnap.exists()){
    toast('Workspace não existe mais.', true);
    state.workspaceId = null;
    localStorage.removeItem(LS_LAST_WS);
    showWorkspaceUI();
    return;
  }
  state.workspace = wsSnap.data();

  // Listener nos metadados (membros, nome, código)
  state.unsubs.push(onSnapshot(wsRef, s => {
    if(s.exists()){
      state.workspace = s.data();
      renderUserMenu();
    }
  }));

  // Listener em folhas (sheets)
  const sheetsCol = collection(db, 'workspaces', wsId, 'sheets');
  state.unsubs.push(onSnapshot(sheetsCol, snap => applySheetsSnapshot(snap)));

  // Listener em projetos (pmData)
  const projectsCol = collection(db, 'workspaces', wsId, 'projects');
  state.unsubs.push(onSnapshot(projectsCol, snap => applyProjectsSnapshot(snap)));

  // Listener em logos
  const logosCol = collection(db, 'workspaces', wsId, 'logos');
  state.unsubs.push(onSnapshot(logosCol, snap => applyLogosSnapshot(snap)));

  hideWorkspaceUI();
  hideAuthUI();
  renderUserMenu();
  setStatus('syncing', 'Carregando…');
}

function cleanupListeners(){
  state.unsubs.forEach(u => { try{ u(); }catch(e){} });
  state.unsubs = [];
}

/* ----------------------------------------------------------------------------
   APLICAR SNAPSHOTS NO ESTADO LOCAL DO APP
   (sheets, pmData, logos são variáveis globais do index.html)
---------------------------------------------------------------------------- */
let _firstSheetsSnapshot   = true;
let _firstProjectsSnapshot = true;
let _firstLogosSnapshot    = true;

function applySheetsSnapshot(snap){
  state.applying = true;
  try{
    const remote = {};
    snap.forEach(d => { remote[d.id] = d.data(); });
    const remoteCount = Object.keys(remote).length;

    // MIGRAÇÃO: primeiro snapshot vazio mas tem dados locais → upload em vez de apagar
    if(_firstSheetsSnapshot && remoteCount === 0){
      _firstSheetsSnapshot = false;
      const local = (window.sheets || []).filter(s => s && s.id);
      if(local.length){
        console.log('[MTM·FB] Migrando ' + local.length + ' folha(s) local(is) para o workspace...');
        toast('🚀 Migrando suas folhas locais para a equipe (' + local.length + ' folha(s))...');
        state.applying = false;
        // Força um saveSheets que vai enfileirar tudo pro Firestore
        if(typeof window.saveSheets === 'function') window.saveSheets();
        finishInitialLoadIfReady();
        return;
      }
    }
    _firstSheetsSnapshot = false;

    // Reconstroi sheets array no formato esperado pelo app
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

    // Persiste no cache local
    try{
      localStorage.setItem('mtm_sheets_v1', JSON.stringify(arr));
    }catch(e){}

    // Re-renderiza
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

    // MIGRAÇÃO equivalente para pmData
    if(_firstProjectsSnapshot && remoteCount === 0){
      _firstProjectsSnapshot = false;
      const local = window.pmData || {};
      if(Object.keys(local).length){
        console.log('[MTM·FB] Migrando ' + Object.keys(local).length + ' empresa(s) local(is)...');
        state.applying = false;
        if(typeof window.pmSave === 'function') window.pmSave();
        finishInitialLoadIfReady();
        return;
      }
    }
    _firstProjectsSnapshot = false;

    // pmData no formato { folderId: { id, name, logo, projects:[...] } }
    if(typeof window.pmData !== 'undefined'){
      window.pmData = obj;
    }

    try{ localStorage.setItem('pmgr_v3', JSON.stringify(obj)); }catch(e){}

    // Re-renderiza painel de projetos se aberto
    if(typeof window.pmRefreshIfOpen === 'function') window.pmRefreshIfOpen();
    else if(typeof window.pmView === 'function' && document.getElementById('pm-overlay') && document.getElementById('pm-overlay').classList.contains('open')){
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

    // MIGRAÇÃO equivalente para logos
    if(_firstLogosSnapshot && remoteCount === 0){
      _firstLogosSnapshot = false;
      let localLogos = {};
      try{ localLogos = JSON.parse(localStorage.getItem('mtm_client_logos_v1') || '{}') || {}; }catch(e){}
      if(Object.keys(localLogos).length){
        console.log('[MTM·FB] Migrando ' + Object.keys(localLogos).length + ' logo(s) local(is)...');
        state.applying = false;
        if(typeof window.dbSaveClientLogos === 'function') window.dbSaveClientLogos(localLogos);
        finishInitialLoadIfReady();
        return;
      }
    }
    _firstLogosSnapshot = false;

    try{ localStorage.setItem('mtm_client_logos_v1', JSON.stringify(obj)); }catch(e){}
  } finally {
    state.applying = false;
    finishInitialLoadIfReady();
  }
}

function rerenderSheets(){
  // Remove cards de folhas que não existem mais
  document.querySelectorAll('.folha-content').forEach(el => {
    const id = el.id.replace(/^c-/, '');
    if(!window.sheets.find(s => s.id === id)) el.remove();
  });
  // Adiciona / atualiza
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
  // Garante pelo menos uma folha
  if(window.sheets && window.sheets.length === 0 && typeof window.addSheet === 'function'){
    window.addSheet('FOLHA 1');  // isso vai gravar no Firestore via wrapper
  }
}

/* ----------------------------------------------------------------------------
   WRITE LAYER — wrappers nas funções de save originais
   Intercepta saveSheets, pmSave, dbSaveClientLogos
---------------------------------------------------------------------------- */
const writeQueue = {
  sheets:   new Map(),  // id → payload
  projects: new Map(),  // id → payload
  logos:    new Map(),  // client → dataUrl
  flushTimer: null
};

function scheduleFlush(){
  clearTimeout(writeQueue.flushTimer);
  writeQueue.flushTimer = setTimeout(flushWrites, 400);
}

async function flushWrites(){
  if(!state.workspaceId || !state.user) return;
  if(state.applying) return; // estamos aplicando remoto, não echoa

  const wsId  = state.workspaceId;
  const batch = writeBatch(db);
  let count   = 0;

  // sheets
  writeQueue.sheets.forEach((payload, id) => {
    const ref = doc(db, 'workspaces', wsId, 'sheets', id);
    batch.set(ref, { ...payload, updatedAt: serverTimestamp(), updatedBy: state.user.uid }, { merge:false });
    count++;
  });
  writeQueue.sheets.clear();

  // projects
  writeQueue.projects.forEach((payload, id) => {
    const ref = doc(db, 'workspaces', wsId, 'projects', id);
    batch.set(ref, { ...payload, updatedAt: serverTimestamp(), updatedBy: state.user.uid }, { merge:false });
    count++;
  });
  writeQueue.projects.clear();

  // logos
  writeQueue.logos.forEach((dataUrl, client) => {
    const ref = doc(db, 'workspaces', wsId, 'logos', sanitizeKey(client));
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

function sanitizeKey(s){ return String(s||'').replace(/[\/\\.#$\[\]]/g, '_').slice(0,150) || '_'; }

/* Detecta IDs deletados comparando array local vs Firestore */
async function syncSheetDeletions(){
  if(!state.workspaceId || state.applying) return;
  // pega ids remotos atuais via cache do snapshot
  const wsId = state.workspaceId;
  const sheetsCol = collection(db, 'workspaces', wsId, 'sheets');
  try{
    const { getDocs } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js');
    const snap = await getDocs(sheetsCol);
    const remoteIds = new Set(); snap.forEach(d => remoteIds.add(d.id));
    const localIds  = new Set((window.sheets||[]).map(s => s.id));
    const toDelete  = [];
    remoteIds.forEach(id => { if(!localIds.has(id)) toDelete.push(id); });
    if(toDelete.length){
      const batch = writeBatch(db);
      toDelete.forEach(id => batch.delete(doc(db, 'workspaces', wsId, 'sheets', id)));
      await batch.commit();
    }
  }catch(e){ console.warn('syncSheetDeletions', e); }
}

async function syncProjectDeletions(){
  if(!state.workspaceId || state.applying) return;
  const wsId = state.workspaceId;
  const col  = collection(db, 'workspaces', wsId, 'projects');
  try{
    const { getDocs } = await import('https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js');
    const snap = await getDocs(col);
    const remoteIds = new Set(); snap.forEach(d => remoteIds.add(d.id));
    const localIds  = new Set(Object.keys(window.pmData||{}));
    const toDelete  = [];
    remoteIds.forEach(id => { if(!localIds.has(id)) toDelete.push(id); });
    if(toDelete.length){
      const batch = writeBatch(db);
      toDelete.forEach(id => batch.delete(doc(db, 'workspaces', wsId, 'projects', id)));
      await batch.commit();
    }
  }catch(e){ console.warn('syncProjectDeletions', e); }
}

/* ----------------------------------------------------------------------------
   PATCH NAS FUNÇÕES EXISTENTES (saveSheets, pmSave, dbSaveClientLogos)
   Espera o DOM e o resto do JS carregarem.
---------------------------------------------------------------------------- */
function patchAppFunctions(){
  // saveSheets
  if(typeof window.saveSheets === 'function' && !window.saveSheets.__fbPatched){
    const orig = window.saveSheets;
    window.saveSheets = function(){
      orig.apply(this, arguments);
      if(!state.workspaceId || state.applying) return;
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
      // Tratar deleções (se sheets foi reduzido)
      syncSheetDeletions();
    };
    window.saveSheets.__fbPatched = true;
  }

  // pmSave
  if(typeof window.pmSave === 'function' && !window.pmSave.__fbPatched){
    const orig = window.pmSave;
    window.pmSave = function(){
      orig.apply(this, arguments);
      if(!state.workspaceId || state.applying) return;
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
      syncProjectDeletions();
    };
    window.pmSave.__fbPatched = true;
  }

  // dbSaveClientLogos
  if(typeof window.dbSaveClientLogos === 'function' && !window.dbSaveClientLogos.__fbPatched){
    const orig = window.dbSaveClientLogos;
    window.dbSaveClientLogos = function(obj){
      orig.apply(this, arguments);
      if(!state.workspaceId || state.applying) return;
      const o = obj || {};
      Object.keys(o).forEach(client => {
        writeQueue.logos.set(client, o[client] || '');
      });
      scheduleFlush();
    };
    window.dbSaveClientLogos.__fbPatched = true;
  }

  // salvarAgora também grava no Firestore via saveSheets/pmSave já patched (acontece dentro)
}

/* ----------------------------------------------------------------------------
   MENU DO USUÁRIO
---------------------------------------------------------------------------- */
function renderUserMenu(){
  const slot = document.getElementById('fb-user-slot');
  if(!slot) return;
  if(!state.user){ slot.innerHTML = ''; return; }

  const name = state.user.displayName || state.user.email || 'Usuário';
  const initial = name.charAt(0).toUpperCase();
  const wsName  = state.workspace ? state.workspace.name : '—';
  const members = state.workspace && state.workspace.members ? Object.keys(state.workspace.members).length : 0;

  slot.innerHTML = `
    <div class="fb-sync-badge" id="mtm-sync-badge" data-kind="syncing" title="Status de sincronização">
      <span class="sync-dot"></span>
      <span class="sync-label">Conectando…</span>
    </div>
    <button class="fb-user-btn" onclick="fbToggleUserMenu()" title="${escapeHtml(name)} · ${escapeHtml(wsName)}">
      <span class="fb-avatar">${escapeHtml(initial)}</span>
      <span class="fb-user-info">
        <span class="fb-user-name">${escapeHtml(name.split(' ')[0])}</span>
        <span class="fb-ws-name">${escapeHtml(wsName)} · ${members} 👥</span>
      </span>
      <span class="fb-chev">▾</span>
    </button>
    <div class="fb-user-menu" id="fb-user-menu">
      <div class="fb-menu-header">
        <div class="fb-menu-name">${escapeHtml(name)}</div>
        <div class="fb-menu-email">${escapeHtml(state.user.email||'')}</div>
      </div>
      <button class="fb-menu-item" onclick="fbShowInviteCode()">
        🔑 <span>Código de convite da equipe</span>
      </button>
      <button class="fb-menu-item" onclick="fbOpenWorkspaceScreen()">
        🔄 <span>Trocar workspace</span>
      </button>
      <button class="fb-menu-item fb-menu-danger" onclick="fbLogout()">
        🚪 <span>Sair</span>
      </button>
    </div>
  `;
  // garante o estado do badge
  bumpPending(0);
}

window.fbToggleUserMenu = function(){
  const m = document.getElementById('fb-user-menu');
  if(m) m.classList.toggle('open');
};

document.addEventListener('click', function(e){
  const m = document.getElementById('fb-user-menu');
  const btn = e.target.closest('.fb-user-btn');
  if(!m || !m.classList.contains('open')) return;
  if(btn) return;
  if(!e.target.closest('.fb-user-menu')) m.classList.remove('open');
});

function escapeHtml(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* ----------------------------------------------------------------------------
   FLUXO PRINCIPAL — onAuthStateChanged
---------------------------------------------------------------------------- */
function waitForDom(){
  return new Promise(res => {
    if(document.readyState !== 'loading') res();
    else document.addEventListener('DOMContentLoaded', res);
  });
}

onAuthStateChanged(auth, async user => {
  await waitForDom();

  if(!user){
    state.user = null;
    cleanupListeners();
    state.workspaceId = null;
    state.workspace   = null;
    showAuthUI();
    renderUserMenu();
    return;
  }
  state.user = user;
  hideAuthUI();

  // Patch das funções do app (esperamos elas estarem no global)
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

  // Inicializa app em background (renderiza UI vazia)
  if(typeof window.startDirectMtmApp === 'function'){
    window.startDirectMtmApp();
  } else {
    // Espera carregar
    const tryBoot = setInterval(()=>{
      if(typeof window.startDirectMtmApp === 'function'){
        clearInterval(tryBoot);
        window.startDirectMtmApp();
      }
    }, 80);
  }
  renderUserMenu();

  // Tenta entrar no último workspace usado
  const lastWs = localStorage.getItem(LS_LAST_WS);
  if(lastWs){
    try{
      const wd = await getDoc(doc(db, 'workspaces', lastWs));
      if(wd.exists() && wd.data().members && wd.data().members[user.uid]){
        await enterWorkspace(lastWs);
        return;
      }
    }catch(e){ console.warn('last ws check', e); }
  }
  // Caso contrário, mostra escolha
  showWorkspaceUI();
  buildWorkspaceList();
});

/* ----------------------------------------------------------------------------
   EXPORTS para debug (window.MTMFB)
---------------------------------------------------------------------------- */
window.MTMFB = {
  state, db, auth,
  flushWrites,
  enterWorkspace
};

console.log('[MTM·FB] módulo carregado.');
