/* ================================================================
   firebase-mtm.js  —  Módulo de Integração Firebase
   Projeto: MTM EM FOCO
   ================================================================ */

(function () {
  'use strict';

  /* ──────────────────────────────────────────────────────────────
     1. CONFIGURAÇÃO DO FIREBASE
  ────────────────────────────────────────────────────────────── */
  const firebaseConfig = {
    apiKey:            "AIzaSyD3cOYgBvVbX8VHeYSe7iLY9c2ozKFtJZY",
    authDomain:        "mtm-em-foco.firebaseapp.com",
    projectId:         "mtm-em-foco",
    storageBucket:     "mtm-em-foco.firebasestorage.app",
    messagingSenderId: "323473561940",
    appId:             "1:323473561940:web:ee9f4e4f1f9ea53c5210c1"
  };

  /* ──────────────────────────────────────────────────────────────
     2. CHAVES DO LOCALSTORAGE QUE SERÃO SINCRONIZADAS NA NUVEM
  ────────────────────────────────────────────────────────────── */
  const SYNC_KEYS = [
    'mtm_sheets',
    'pmgr_v3',
    'mtm_client_logos_v1'
  ];

  /* ──────────────────────────────────────────────────────────────
     3. ESTADO INTERNO
  ────────────────────────────────────────────────────────────── */
  let auth, db, currentUser = null;
  let syncPending = {};
  let syncTimer   = null;
  let isOnline    = navigator.onLine;

  /* ──────────────────────────────────────────────────────────────
     4. CARREGAR SDKs DO FIREBASE VIA CDN
  ────────────────────────────────────────────────────────────── */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  async function loadFirebaseSDKs() {
    const BASE = 'https://www.gstatic.com/firebasejs/10.12.2/';
    await loadScript(BASE + 'firebase-app-compat.js');
    await loadScript(BASE + 'firebase-auth-compat.js');
    await loadScript(BASE + 'firebase-firestore-compat.js');
  }

  /* ──────────────────────────────────────────────────────────────
     5. INICIALIZAR FIREBASE
  ────────────────────────────────────────────────────────────── */
  function initFirebase() {
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db   = firebase.firestore();

    db.enablePersistence({ synchronizeTabs: true }).catch(function (e) {
      if (e.code === 'failed-precondition')
        console.warn('[fbmtm] Persistência: múltiplas abas abertas.');
    });

    auth.onAuthStateChanged(function (user) {
      currentUser = user;
      updateStatusBar();
      if (user) {
        closeOverlay();
        showToastFB('👋 Bem-vindo, ' + (user.displayName || user.email.split('@')[0]) + '!', false, 3000);
        loadUserData();
      } else {
        buildLoginUI();
      }
    });
  }

  /* ──────────────────────────────────────────────────────────────
     6. UI DE LOGIN
  ────────────────────────────────────────────────────────────── */
  function buildLoginUI() {
    if (document.getElementById('fbmtm-overlay')) return;
    const ov = document.createElement('div');
    ov.id = 'fbmtm-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(8,11,18,.97);display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;backdrop-filter:blur(16px);';

    ov.innerHTML = `
      <div style="background:#0e1420;border:1px solid rgba(0,212,255,.2);border-radius:16px;padding:36px 40px;width:380px;max-width:95vw;box-shadow:0 24px 64px rgba(0,0,0,.9);">

        <div style="text-align:center;margin-bottom:28px">
          <div style="font-size:22px;font-weight:800;letter-spacing:1px;background:linear-gradient(135deg,#00d4ff,#4f8ef7,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">MTM EM FOCO</div>
          <div style="color:#7a8aaa;font-size:12px;margin-top:5px">☁️ Sincronização em Nuvem · Firebase</div>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:24px">
          <button id="fbmtm-tab-l" onclick="fbmtmShowTab('login')"  style="flex:1;padding:8px;border-radius:8px;border:1px solid rgba(0,212,255,.35);background:rgba(0,212,255,.1);color:#00d4ff;font-weight:700;font-size:12px;cursor:pointer;font-family:Inter,sans-serif;">Entrar</button>
          <button id="fbmtm-tab-s" onclick="fbmtmShowTab('signup')" style="flex:1;padding:8px;border-radius:8px;border:1px solid rgba(255,255,255,.08);background:transparent;color:#7a8aaa;font-weight:600;font-size:12px;cursor:pointer;font-family:Inter,sans-serif;">Criar Conta</button>
        </div>

        <div id="fbmtm-fl">
          <input id="fbmtm-el" type="email"    placeholder="E-mail" style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:#131a28;color:#f0f4ff;font-size:13px;margin-bottom:10px;outline:none;font-family:Inter,sans-serif;box-sizing:border-box;">
          <input id="fbmtm-pl" type="password" placeholder="Senha"  style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:#131a28;color:#f0f4ff;font-size:13px;margin-bottom:14px;outline:none;font-family:Inter,sans-serif;box-sizing:border-box;">
          <button onclick="fbmtmLogin()" style="width:100%;padding:12px;border-radius:8px;border:none;background:linear-gradient(135deg,#00d4ff,#4f8ef7,#7c3aed);color:#fff;font-weight:700;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;">Entrar</button>
          <div onclick="fbmtmResetPass()" style="text-align:center;margin-top:12px;color:#4f8ef7;font-size:11px;cursor:pointer;text-decoration:underline;">Esqueci minha senha</div>
        </div>

        <div id="fbmtm-fs" style="display:none">
          <input id="fbmtm-ns" type="text"     placeholder="Seu nome"              style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:#131a28;color:#f0f4ff;font-size:13px;margin-bottom:10px;outline:none;font-family:Inter,sans-serif;box-sizing:border-box;">
          <input id="fbmtm-es" type="email"    placeholder="E-mail"                style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:#131a28;color:#f0f4ff;font-size:13px;margin-bottom:10px;outline:none;font-family:Inter,sans-serif;box-sizing:border-box;">
          <input id="fbmtm-ps" type="password" placeholder="Senha (mín. 4 dígitos)" style="width:100%;padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:#131a28;color:#f0f4ff;font-size:13px;margin-bottom:14px;outline:none;font-family:Inter,sans-serif;box-sizing:border-box;">
          <button onclick="fbmtmSignup()" style="width:100%;padding:12px;border-radius:8px;border:none;background:linear-gradient(135deg,#00e5a0,#00b87a);color:#001a12;font-weight:700;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;">Criar Conta</button>
        </div>

        <div id="fbmtm-msg" style="margin-top:14px;text-align:center;font-size:12px;color:#ff4d6d;min-height:18px;font-family:Inter,sans-serif;"></div>

        <hr style="border:none;border-top:1px solid rgba(255,255,255,.06);margin:20px 0">
        <div style="text-align:center">
          <button onclick="fbmtmSkipLogin()" style="background:transparent;border:1px solid rgba(255,255,255,.1);color:#7a8aaa;padding:8px 20px;border-radius:8px;font-size:11px;cursor:pointer;font-family:Inter,sans-serif;">Usar sem conta (somente local)</button>
        </div>
      </div>
    `;

    document.body.appendChild(ov);
    ov.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var fs = document.getElementById('fbmtm-fs');
      if (fs && fs.style.display !== 'none') fbmtmSignup(); else fbmtmLogin();
    });
  }

  /* ──────────────────────────────────────────────────────────────
     7. FUNÇÕES GLOBAIS
  ────────────────────────────────────────────────────────────── */
  window.fbmtmShowTab = function (tab) {
    var fl = document.getElementById('fbmtm-fl');
    var fs = document.getElementById('fbmtm-fs');
    var tl = document.getElementById('fbmtm-tab-l');
    var ts = document.getElementById('fbmtm-tab-s');
    if (!fl) return;
    fl.style.display = tab === 'login'  ? '' : 'none';
    fs.style.display = tab === 'signup' ? '' : 'none';
    if (tab === 'login') {
      tl.style.cssText += 'background:rgba(0,212,255,.1);color:#00d4ff;border-color:rgba(0,212,255,.35);';
      ts.style.cssText += 'background:transparent;color:#7a8aaa;border-color:rgba(255,255,255,.08);';
    } else {
      ts.style.cssText += 'background:rgba(0,229,160,.1);color:#00e5a0;border-color:rgba(0,229,160,.35);';
      tl.style.cssText += 'background:transparent;color:#7a8aaa;border-color:rgba(255,255,255,.08);';
    }
    setMsg('');
  };

  window.fbmtmLogin = async function () {
    var email = g('fbmtm-el'); var pass = g('fbmtm-pl');
    if (!email || !pass) { setMsg('Preencha e-mail e senha.'); return; }
    setMsg('Entrando...', '#4f8ef7');
    try { await auth.signInWithEmailAndPassword(email, pass); }
    catch (e) { setMsg(ferr(e.code)); }
  };

  window.fbmtmSignup = async function () {
    var name = g('fbmtm-ns'); var email = g('fbmtm-es'); var pass = g('fbmtm-ps');
    if (!name || !email || !pass) { setMsg('Preencha todos os campos.'); return; }
    if (pass.length < 4) { setMsg('Senha deve ter no mínimo 4 dígitos.'); return; }
    setMsg('Criando conta...', '#00e5a0');
    try {
      var c = await auth.createUserWithEmailAndPassword(email, pass);
      await c.user.updateProfile({ displayName: name });
    } catch (e) { setMsg(ferr(e.code)); }
  };

  window.fbmtmResetPass = async function () {
    var email = g('fbmtm-el');
    if (!email) { setMsg('Digite seu e-mail primeiro.'); return; }
    try { await auth.sendPasswordResetEmail(email); setMsg('✅ E-mail de recuperação enviado!', '#00e5a0'); }
    catch (e) { setMsg(ferr(e.code)); }
  };

  window.fbmtmSkipLogin = function () {
    closeOverlay();
    showToastFB('ℹ️ Modo local ativado — dados somente neste navegador', false, 4000);
  };

  window.fbmtmOpenUserMenu = function () {
    if (!currentUser) { buildLoginUI(); return; }
    if (confirm('👤 ' + (currentUser.displayName || currentUser.email) + '\n' + currentUser.email + '\n\nDeseja sair da conta?')) {
      auth.signOut();
    }
  };

  function closeOverlay() { var e = document.getElementById('fbmtm-overlay'); if (e) e.remove(); }
  function g(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }
  function setMsg(t, c) { var e = document.getElementById('fbmtm-msg'); if (e) { e.textContent = t; e.style.color = c || '#ff4d6d'; } }
  function ferr(code) {
    return ({
      'auth/user-not-found':       'Usuário não encontrado.',
      'auth/wrong-password':       'Senha incorreta.',
      'auth/invalid-credential':   'E-mail ou senha incorretos.',
      'auth/email-already-in-use': 'E-mail já cadastrado.',
      'auth/invalid-email':        'E-mail inválido.',
      'auth/weak-password':        'Senha muito fraca.',
      'auth/too-many-requests':    'Muitas tentativas. Aguarde.',
      'auth/network-request-failed':'Sem conexão com a internet.',
    }[code] || 'Erro: ' + code);
  }

  /* ──────────────────────────────────────────────────────────────
     8. BARRA DE STATUS
  ────────────────────────────────────────────────────────────── */
  function buildStatusBar() {
    if (document.getElementById('fbmtm-status')) return;
    var bar = document.createElement('div');
    bar.id = 'fbmtm-status';
    bar.title = 'Clique para gerenciar conta';
    bar.onclick = function () { window.fbmtmOpenUserMenu(); };
    bar.style.cssText = 'position:fixed;bottom:12px;right:14px;z-index:9998;display:flex;align-items:center;gap:8px;background:rgba(14,20,32,.92);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:5px 14px;font-family:Inter,sans-serif;font-size:11px;color:#7a8aaa;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.5);backdrop-filter:blur(8px);user-select:none;';
    document.body.appendChild(bar);
    updateStatusBar();
  }

  function updateStatusBar() {
    var bar = document.getElementById('fbmtm-status');
    if (!bar) return;
    if (currentUser) {
      var name = currentUser.displayName || currentUser.email.split('@')[0];
      bar.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#00e5a0;display:inline-block"></span><span style="color:#f0f4ff;font-weight:600">' + name.replace(/</g,'&lt;') + '</span><span style="color:#4f8ef7">☁️ nuvem</span>';
    } else {
      bar.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:#ff9500;display:inline-block"></span><span>Sem login · só local</span>';
    }
  }

  /* ──────────────────────────────────────────────────────────────
     9. FIRESTORE — SINCRONIZAÇÃO
  ────────────────────────────────────────────────────────────── */
  function userDoc(key) {
    return db.collection('users').doc(currentUser.uid).collection('data').doc(key);
  }

  function scheduleSyncKey(key, value) {
    if (!currentUser) return;
    syncPending[key] = value;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(flushSync, 2000);
  }

  async function flushSync() {
    if (!currentUser || !isOnline) return;
    var keys = Object.keys(syncPending);
    if (!keys.length) return;
    var batch = db.batch();
    keys.forEach(function (k) {
      if (syncPending[k] == null) return;
      batch.set(userDoc(k), { value: syncPending[k], ts: firebase.firestore.FieldValue.serverTimestamp() });
    });
    syncPending = {};
    try { await batch.commit(); showToastFB('☁️ Salvo na nuvem', false, 1800); }
    catch (e) { showToastFB('⚠️ Falha ao salvar na nuvem', true, 3000); }
  }

  async function loadUserData() {
    if (!currentUser) return;
    showToastFB('☁️ Carregando seus dados...', false, 3000);
    try {
      var hasData = false;
      for (var i = 0; i < SYNC_KEYS.length; i++) {
        var key = SYNC_KEYS[i];
        var doc = await userDoc(key).get();
        if (doc.exists && doc.data().value) {
          _origSetItem.call(localStorage, key, doc.data().value);
          hasData = true;
        }
      }
      if (hasData) {
        showToastFB('✅ Dados carregados da nuvem!', false, 3000);
        reloadAppData();
      } else {
        showToastFB('☁️ Conta nova — sincronizando dados locais...', false, 3000);
        SYNC_KEYS.forEach(function (key) {
          var local = _origGetItem.call(localStorage, key);
          if (local) scheduleSyncKey(key, local);
        });
      }
    } catch (e) {
      console.warn('[fbmtm] Erro ao carregar:', e);
      showToastFB('⚠️ Erro ao carregar dados da nuvem', true, 4000);
    }
  }

  function reloadAppData() {
    try {
      if (typeof loadSheets  === 'function') loadSheets();
      if (typeof pmLoad      === 'function') pmLoad();
      if (typeof renderTabs  === 'function') renderTabs();
    } catch (e) {
      setTimeout(function () { location.reload(); }, 600);
    }
  }

  /* ──────────────────────────────────────────────────────────────
     10. INTERCEPTAR LOCALSTORAGE
  ────────────────────────────────────────────────────────────── */
  var _origSetItem = localStorage.setItem.bind(localStorage);
  var _origGetItem = localStorage.getItem.bind(localStorage);

  localStorage.setItem = function (key, value) {
    _origSetItem(key, value);
    if (SYNC_KEYS.indexOf(key) !== -1) scheduleSyncKey(key, value);
  };

  /* ──────────────────────────────────────────────────────────────
     11. TOAST
  ────────────────────────────────────────────────────────────── */
  function showToastFB(msg, isError, duration) {
    if (typeof showToast === 'function') { showToast(msg, isError); return; }
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:52px;right:14px;z-index:99997;background:' + (isError ? '#2a0a10' : '#0a1a2a') + ';border:1px solid ' + (isError ? '#ff4d6d' : '#00d4ff') + ';color:' + (isError ? '#ff4d6d' : '#f0f4ff') + ';padding:9px 16px;border-radius:8px;font-size:12px;font-family:Inter,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5);';
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(function () { t.remove(); }, 300); }, duration || 3500);
  }

  /* ──────────────────────────────────────────────────────────────
     12. CONECTIVIDADE
  ────────────────────────────────────────────────────────────── */
  window.addEventListener('online',  function () { isOnline = true;  showToastFB('🌐 Conexão restaurada!', false, 3000); if (Object.keys(syncPending).length) flushSync(); });
  window.addEventListener('offline', function () { isOnline = false; showToastFB('📴 Sem conexão — salvando localmente', true, 4000); });

  /* ──────────────────────────────────────────────────────────────
     13. INICIAR
  ────────────────────────────────────────────────────────────── */
  async function init() {
    try {
      await loadFirebaseSDKs();
      initFirebase();
      buildStatusBar();
      console.log('[fbmtm] ✅ Firebase MTM EM FOCO inicializado!');
    } catch (e) {
      console.error('[fbmtm] Erro ao inicializar:', e);
      showToastFB('⚠️ Firebase indisponível — modo local ativado', true, 5000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
