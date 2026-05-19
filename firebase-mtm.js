/* ================================================================
   firebase-mtm.js  —  MTM EM FOCO · Firebase Auth + Firestore
   Login: Email + Senha
   Cadastro: Nome + Email + Senha → entra automaticamente
   ================================================================ */
(function () {
  'use strict';

  const firebaseConfig = {
    apiKey:            "AIzaSyD3cOYgBvVbX8VHeYSe7iLY9c2ozKFtJZY",
    authDomain:        "mtm-em-foco.firebaseapp.com",
    projectId:         "mtm-em-foco",
    storageBucket:     "mtm-em-foco.firebasestorage.app",
    messagingSenderId: "323473561940",
    appId:             "1:323473561940:web:ee9f4e4f1f9ea53c5210c1"
  };

  const SYNC_KEYS = ['mtm_sheets','pmgr_v3','mtm_client_logos_v1'];
  let auth, db, currentUser = null;
  let syncPending = {}, syncTimer = null, isOnline = navigator.onLine;

  /* ── CARREGAR SDKs ── */
  function loadScript(src) {
    return new Promise(function(res,rej){
      var s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  async function loadFirebaseSDKs() {
    const B = 'https://www.gstatic.com/firebasejs/10.12.2/';
    await loadScript(B + 'firebase-app-compat.js');
    await loadScript(B + 'firebase-auth-compat.js');
    await loadScript(B + 'firebase-firestore-compat.js');
  }

  /* ── INIT ── */
  function initFirebase() {
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db   = firebase.firestore();
    db.enablePersistence({synchronizeTabs:true}).catch(function(){});

    /* Quando logar → fecha tela e carrega dados automaticamente */
    auth.onAuthStateChanged(function(user) {
      currentUser = user;
      updateStatusBar();
      if (user) {
        closeOverlay();
        var nome = user.displayName || user.email.split('@')[0];
        showToastFB('👋 Bem-vindo, ' + nome + '!', false, 3000);
        loadUserData();
      } else {
        buildLoginUI();
      }
    });
  }

  /* ── ESTILOS REUTILIZÁVEIS ── */
  var S_INPUT = 'width:100%;padding:12px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:#111827;color:#f0f4ff;font-size:14px;margin-bottom:12px;outline:none;font-family:Inter,sans-serif;box-sizing:border-box;transition:border-color .2s;';
  var S_INPUT_PASS = 'width:100%;padding:12px 44px 12px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.12);background:#111827;color:#f0f4ff;font-size:14px;outline:none;font-family:Inter,sans-serif;box-sizing:border-box;transition:border-color .2s;';

  function fieldPass(id, ph) {
    return '<div style="position:relative;margin-bottom:12px;">'
      + '<input id="'+id+'" type="password" placeholder="'+ph+'" style="'+S_INPUT_PASS+'">'
      + '<button type="button" onclick="fbmtmEye(\''+id+'\')" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:17px;color:#7a8aaa;padding:2px;">👁</button>'
      + '</div>';
  }

  /* ── BUILD UI ── */
  function buildLoginUI() {
    if (document.getElementById('fbmtm-overlay')) return;
    var ov = document.createElement('div');
    ov.id = 'fbmtm-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,8,15,.97);display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;backdrop-filter:blur(20px);';
    ov.innerHTML = `
      <div style="background:#0d1525;border:1px solid rgba(0,212,255,.18);border-radius:20px;padding:40px 44px;width:420px;max-width:96vw;box-shadow:0 32px 80px rgba(0,0,0,.95),0 0 40px rgba(0,212,255,.06);">

        <div style="text-align:center;margin-bottom:32px">
          <div style="font-size:26px;font-weight:800;letter-spacing:1.5px;background:linear-gradient(135deg,#00d4ff,#4f8ef7,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">MTM EM FOCO</div>
          <div style="color:#7a8aaa;font-size:12px;margin-top:6px">☁️ Sincronização em Nuvem · Firebase</div>
        </div>

        <!-- ABAS -->
        <div style="display:flex;gap:6px;margin-bottom:28px;">
          <button id="fbmtm-tab-l" onclick="fbmtmShowTab('login')" style="flex:1;padding:10px;border-radius:9px;border:1px solid rgba(0,212,255,.35);background:rgba(0,212,255,.1);color:#00d4ff;font-weight:700;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;">Entrar</button>
          <button id="fbmtm-tab-s" onclick="fbmtmShowTab('signup')" style="flex:1;padding:10px;border-radius:9px;border:1px solid rgba(255,255,255,.08);background:transparent;color:#7a8aaa;font-weight:600;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;">Criar Conta</button>
        </div>

        <!-- LOGIN: Email + Senha -->
        <div id="fbmtm-fl">
          <label style="color:#7a8aaa;font-size:11px;font-weight:600;letter-spacing:.5px;display:block;margin-bottom:5px;">E-MAIL</label>
          <input id="fbmtm-el" type="email" placeholder="seu@email.com" style="${S_INPUT}">
          <label style="color:#7a8aaa;font-size:11px;font-weight:600;letter-spacing:.5px;display:block;margin-bottom:5px;">SENHA</label>
          ${fieldPass('fbmtm-pl','••••••••')}
          <button onclick="fbmtmLogin()" style="width:100%;padding:14px;border-radius:9px;border:none;background:linear-gradient(135deg,#00d4ff,#4f8ef7,#7c3aed);color:#fff;font-weight:700;font-size:14px;cursor:pointer;font-family:Inter,sans-serif;margin-top:4px;letter-spacing:.3px;">Entrar</button>
          <div onclick="fbmtmReset()" style="text-align:center;margin-top:13px;color:#4f8ef7;font-size:12px;cursor:pointer;text-decoration:underline;">Esqueci minha senha</div>
        </div>

        <!-- CADASTRO: Nome + Email + Senha → entra direto -->
        <div id="fbmtm-fs" style="display:none">
          <label style="color:#7a8aaa;font-size:11px;font-weight:600;letter-spacing:.5px;display:block;margin-bottom:5px;">NOME COMPLETO</label>
          <input id="fbmtm-ns" type="text" placeholder="Ivan Carlos Antoneli" style="${S_INPUT}">
          <label style="color:#7a8aaa;font-size:11px;font-weight:600;letter-spacing:.5px;display:block;margin-bottom:5px;">E-MAIL</label>
          <input id="fbmtm-es" type="email" placeholder="seu@email.com" style="${S_INPUT}">
          <label style="color:#7a8aaa;font-size:11px;font-weight:600;letter-spacing:.5px;display:block;margin-bottom:5px;">SENHA</label>
          ${fieldPass('fbmtm-ps','••••••••')}
          <button onclick="fbmtmSignup()" style="width:100%;padding:14px;border-radius:9px;border:none;background:linear-gradient(135deg,#00e5a0,#00b87a);color:#001a12;font-weight:700;font-size:14px;cursor:pointer;font-family:Inter,sans-serif;margin-top:4px;letter-spacing:.3px;">Criar Conta e Entrar</button>
        </div>

        <!-- ERRO / STATUS -->
        <div id="fbmtm-msg" style="margin-top:16px;text-align:center;font-size:13px;color:#ff4d6d;min-height:20px;font-family:Inter,sans-serif;font-weight:500;"></div>

        <hr style="border:none;border-top:1px solid rgba(255,255,255,.06);margin:24px 0">
        <div style="text-align:center">
          <button onclick="fbmtmSkipLogin()" style="background:transparent;border:1px solid rgba(255,255,255,.1);color:#7a8aaa;padding:9px 24px;border-radius:9px;font-size:12px;cursor:pointer;font-family:Inter,sans-serif;">Usar sem conta (somente local)</button>
        </div>
      </div>
    `;
    document.body.appendChild(ov);
    ov.addEventListener('keydown', function(e){
      if (e.key !== 'Enter') return;
      var fs = document.getElementById('fbmtm-fs');
      if (fs && fs.style.display !== 'none') fbmtmSignup(); else fbmtmLogin();
    });
  }

  /* ── ABAS ── */
  window.fbmtmShowTab = function(tab) {
    var fl=document.getElementById('fbmtm-fl'), fs=document.getElementById('fbmtm-fs');
    var tl=document.getElementById('fbmtm-tab-l'), ts=document.getElementById('fbmtm-tab-s');
    if (!fl) return;
    fl.style.display = tab==='login'  ? '' : 'none';
    fs.style.display = tab==='signup' ? '' : 'none';
    tl.style.cssText = tab==='login'
      ? 'flex:1;padding:10px;border-radius:9px;border:1px solid rgba(0,212,255,.35);background:rgba(0,212,255,.1);color:#00d4ff;font-weight:700;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;'
      : 'flex:1;padding:10px;border-radius:9px;border:1px solid rgba(255,255,255,.08);background:transparent;color:#7a8aaa;font-weight:600;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;';
    ts.style.cssText = tab==='signup'
      ? 'flex:1;padding:10px;border-radius:9px;border:1px solid rgba(0,229,160,.35);background:rgba(0,229,160,.1);color:#00e5a0;font-weight:700;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;'
      : 'flex:1;padding:10px;border-radius:9px;border:1px solid rgba(255,255,255,.08);background:transparent;color:#7a8aaa;font-weight:600;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;';
    setMsg('');
  };

  /* ── OLHO SENHA ── */
  window.fbmtmEye = function(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
  };

  /* ── LOGIN ── */
  window.fbmtmLogin = async function() {
    var email = g('fbmtm-el'), pass = g('fbmtm-pl');
    if (!email || !pass) { setMsg('Preencha e-mail e senha.'); return; }
    setMsg('Entrando...', '#4f8ef7');
    try { await auth.signInWithEmailAndPassword(email, pass); }
    catch(e) { setMsg(ferr(e.code)); }
  };

  /* ── CADASTRO → ENTRA DIRETO ── */
  window.fbmtmSignup = async function() {
    var nome  = g('fbmtm-ns');
    var email = g('fbmtm-es');
    var pass  = g('fbmtm-ps');
    if (!nome)  { setMsg('Digite seu nome.'); return; }
    if (!email) { setMsg('Digite seu e-mail.'); return; }
    if (!pass)  { setMsg('Digite uma senha.'); return; }
    if (pass.length < 4) { setMsg('Senha deve ter no mínimo 4 dígitos.'); return; }
    setMsg('Criando conta...', '#00e5a0');
    try {
      /* Cria a conta → onAuthStateChanged dispara automaticamente → fecha tela e entra */
      var cred = await auth.createUserWithEmailAndPassword(email, pass);
      await cred.user.updateProfile({ displayName: nome });
      /* Força refresh para pegar o displayName */
      await auth.currentUser.reload();
    } catch(e) { setMsg(ferr(e.code)); }
  };

  /* ── RESET SENHA ── */
  window.fbmtmReset = async function() {
    var email = g('fbmtm-el');
    if (!email) { setMsg('Digite seu e-mail primeiro.'); return; }
    try {
      await auth.sendPasswordResetEmail(email);
      setMsg('✅ E-mail de recuperação enviado!', '#00e5a0');
    } catch(e) { setMsg(ferr(e.code)); }
  };

  window.fbmtmSkipLogin = function() {
    closeOverlay();
    showToastFB('ℹ️ Modo local ativado — dados somente neste navegador', false, 4000);
  };

  window.fbmtmOpenUserMenu = function() {
    if (!currentUser) { buildLoginUI(); return; }
    var nome = currentUser.displayName || currentUser.email;
    if (confirm('👤 ' + nome + '\n' + currentUser.email + '\n\nDeseja sair da conta?')) {
      auth.signOut();
    }
  };

  function closeOverlay() { var e=document.getElementById('fbmtm-overlay'); if(e) e.remove(); }
  function g(id) { var e=document.getElementById(id); return e?e.value.trim():''; }
  function setMsg(t,c) { var e=document.getElementById('fbmtm-msg'); if(e){e.textContent=t;e.style.color=c||'#ff4d6d';} }
  function ferr(code) {
    return ({
      'auth/user-not-found':        '❌ E-mail não cadastrado.',
      'auth/wrong-password':        '❌ Senha incorreta.',
      'auth/invalid-credential':    '❌ E-mail ou senha incorretos.',
      'auth/email-already-in-use':  '❌ E-mail já cadastrado. Clique em Entrar.',
      'auth/invalid-email':         '❌ E-mail inválido.',
      'auth/weak-password':         '❌ Senha muito fraca (mín. 4 dígitos).',
      'auth/too-many-requests':     '⏳ Muitas tentativas. Aguarde.',
      'auth/network-request-failed':'📴 Sem internet.',
      'auth/api-key-not-valid.-please-pass-a-valid-api-key.':'❌ Abra via ABRIR_MTM.bat (não pelo arquivo direto)',
    }[code] || '❌ ' + code);
  }

  /* ── BARRA DE STATUS ── */
  function buildStatusBar() {
    if (document.getElementById('fbmtm-status')) return;
    var bar = document.createElement('div');
    bar.id = 'fbmtm-status';
    bar.onclick = function(){ window.fbmtmOpenUserMenu(); };
    bar.title = 'Clique para sair da conta';
    bar.style.cssText = 'position:fixed;bottom:12px;right:14px;z-index:9998;display:flex;align-items:center;gap:8px;background:rgba(13,21,37,.94);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:6px 14px;font-family:Inter,sans-serif;font-size:11px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.5);backdrop-filter:blur(8px);user-select:none;';
    document.body.appendChild(bar);
    updateStatusBar();
  }

  function updateStatusBar() {
    var bar = document.getElementById('fbmtm-status'); if (!bar) return;
    if (currentUser) {
      var nome = currentUser.displayName || currentUser.email.split('@')[0];
      bar.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#00e5a0;display:inline-block;flex-shrink:0"></span><span style="color:#f0f4ff;font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+nome.replace(/</g,'&lt;')+'</span><span style="color:#4f8ef7;font-size:13px">☁️</span>';
    } else {
      bar.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ff9500;display:inline-block;flex-shrink:0"></span><span style="color:#7a8aaa;">Sem login</span>';
    }
  }

  /* ── FIRESTORE SYNC ── */
  function userDoc(key) { return db.collection('users').doc(currentUser.uid).collection('data').doc(key); }

  function scheduleSyncKey(key, value) {
    if (!currentUser) return;
    syncPending[key] = value;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSync, 2000);
  }

  async function flushSync() {
    if (!currentUser || !isOnline) return;
    var keys = Object.keys(syncPending); if (!keys.length) return;
    var batch = db.batch();
    keys.forEach(function(k){ if(syncPending[k]!=null) batch.set(userDoc(k),{value:syncPending[k],ts:firebase.firestore.FieldValue.serverTimestamp()}); });
    syncPending = {};
    try { await batch.commit(); showToastFB('☁️ Salvo na nuvem', false, 1800); }
    catch(e) { showToastFB('⚠️ Falha ao salvar na nuvem', true, 3000); }
  }

  async function loadUserData() {
    if (!currentUser) return;
    try {
      var hasData = false;
      for (var i=0; i<SYNC_KEYS.length; i++) {
        var key = SYNC_KEYS[i];
        var doc = await userDoc(key).get();
        if (doc.exists && doc.data().value) { _origSetItem.call(localStorage, key, doc.data().value); hasData=true; }
      }
      if (hasData) { showToastFB('✅ Dados carregados!', false, 2500); reloadAppData(); }
      else { SYNC_KEYS.forEach(function(k){ var l=_origGetItem.call(localStorage,k); if(l) scheduleSyncKey(k,l); }); }
    } catch(e) { console.warn('[fbmtm]',e); }
  }

  function reloadAppData() {
    try {
      if (typeof loadSheets==='function') loadSheets();
      if (typeof pmLoad==='function') pmLoad();
      if (typeof renderTabs==='function') renderTabs();
    } catch(e) { setTimeout(function(){ location.reload(); }, 500); }
  }

  /* ── PATCH LOCALSTORAGE ── */
  var _origSetItem = localStorage.setItem.bind(localStorage);
  var _origGetItem = localStorage.getItem.bind(localStorage);
  localStorage.setItem = function(key, value) {
    _origSetItem(key, value);
    if (SYNC_KEYS.indexOf(key) !== -1) scheduleSyncKey(key, value);
  };

  /* ── TOAST ── */
  function showToastFB(msg, isError, dur) {
    if (typeof showToast==='function') { showToast(msg, isError); return; }
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:52px;right:14px;z-index:99997;background:'+(isError?'#2a0a10':'#0a1422')+';border:1px solid '+(isError?'#ff4d6d':'#00d4ff')+';color:'+(isError?'#ff4d6d':'#f0f4ff')+';padding:9px 16px;border-radius:9px;font-size:12px;font-family:Inter,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5);';
    document.body.appendChild(t);
    setTimeout(function(){ t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(function(){ t.remove(); },300); }, dur||3500);
  }

  /* ── CONECTIVIDADE ── */
  window.addEventListener('online',  function(){ isOnline=true;  showToastFB('🌐 Conexão restaurada!',false,3000); if(Object.keys(syncPending).length) flushSync(); });
  window.addEventListener('offline', function(){ isOnline=false; showToastFB('📴 Sem conexão — salvando localmente',true,4000); });

  /* ── START ── */
  async function init() {
    try {
      await loadFirebaseSDKs();
      initFirebase();
      buildStatusBar();
    } catch(e) {
      console.error('[fbmtm]', e);
      showToastFB('⚠️ Firebase indisponível — modo local', true, 5000);
    }
  }

  if (document.readyState==='loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
