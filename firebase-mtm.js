/* firebase-mtm.js — MTM EM FOCO — sincronização Firestore (Firebase v10 modular / ESM)
   ------------------------------------------------------------------------------------
   Este arquivo agora LÊ as credenciais de window.FIREBASE_CONFIG (definido no index.html),
   em vez de ter uma cópia interna com "COLE_AQUI".

   REQUISITOS no Console do Firebase (https://console.firebase.google.com):
     1) Authentication > Sign-in method > Anonymous  ->  ATIVADO
     2) Firestore Database criado
     3) Regras do Firestore permitindo leitura/escrita para usuários autenticados, ex.:
            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                match /mtm_sync/{doc} {
                  allow read, write: if request.auth != null;
                }
              }
            }
   ------------------------------------------------------------------------------------
   OBS de segurança: a apiKey do Firebase Web é pública por natureza; a proteção real
   vem das REGRAS do Firestore, não do sigilo da chave.
*/

// Se esta versão exata não existir no gstatic, troque o número (ex.: 10.12.0, 10.13.0...).
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

(function () {
  'use strict';

  // Documento único compartilhado por todos os navegadores.
  const STATE_COLLECTION = 'mtm_sync';
  const STATE_DOC = 'global_state';

  // Mesmas chaves de localStorage usadas pelo app.
  const SHEETS_KEY = 'mtm_sheets_v1';
  const PM_KEY = 'pmgr_v3';
  const LOGOS_KEY = 'mtm_client_logos_v1';

  let db = null;
  let stateRef = null;
  let cloudReady = false;
  let applyingCloud = false;
  let saveTimer = null;

  function log()  { console.log.apply(console, ['[MTM Firebase]'].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, ['[MTM Firebase]'].concat([].slice.call(arguments))); }

  // Aviso discreto na tela (não bloqueia como o alert()).
  function toast(msg, isError) {
    try {
      const d = document.createElement('div');
      d.textContent = msg;
      d.style.cssText =
        'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:2147483600;' +
        'background:' + (isError ? 'rgba(255,77,109,.96)' : 'rgba(0,229,160,.96)') + ';' +
        'color:' + (isError ? '#fff' : '#00190f') + ';padding:10px 16px;border-radius:10px;' +
        'font:600 13px Inter,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.45);' +
        'max-width:92vw;text-align:center';
      document.body.appendChild(d);
      setTimeout(function () {
        d.style.transition = 'opacity .5s'; d.style.opacity = '0';
        setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 520);
      }, isError ? 6000 : 2600);
    } catch (e) {}
  }

  function safeJsonGet(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || '') || fallback; }
    catch (e) { return fallback; }
  }
  function safeJsonSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { warn('Falha ao salvar localStorage:', key, e); }
  }

  function getSheetsLocal() {
    try { if (typeof window.sheets !== 'undefined' && Array.isArray(window.sheets)) return window.sheets; } catch (e) {}
    return safeJsonGet(SHEETS_KEY, []);
  }
  function setSheetsLocal(arr) {
    const clean = Array.isArray(arr) ? arr : [];
    try { if (typeof window.sheets !== 'undefined') window.sheets = clean; } catch (e) {}
    safeJsonSet(SHEETS_KEY, clean);
  }
  function getPmLocal() {
    try { if (typeof window.pmData !== 'undefined' && window.pmData && typeof window.pmData === 'object') return window.pmData; } catch (e) {}
    return safeJsonGet(PM_KEY, {});
  }
  function setPmLocal(obj) {
    const clean = obj && typeof obj === 'object' ? obj : {};
    try { if (typeof window.pmData !== 'undefined') window.pmData = clean; } catch (e) {}
    safeJsonSet(PM_KEY, clean);
  }
  function getLogosLocal() { return safeJsonGet(LOGOS_KEY, {}); }
  function setLogosLocal(obj) { safeJsonSet(LOGOS_KEY, obj && typeof obj === 'object' ? obj : {}); }

  function localHasUsefulData() {
    const s = getSheetsLocal(), p = getPmLocal(), l = getLogosLocal();
    return (Array.isArray(s) && s.length > 0) ||
           (p && typeof p === 'object' && Object.keys(p).length > 0) ||
           (l && typeof l === 'object' && Object.keys(l).length > 0);
  }

  function buildState() {
    return {
      sheets: getSheetsLocal(),
      pmData: getPmLocal(),
      clientLogos: getLogosLocal(),
      updatedAt: serverTimestamp(),
      updatedAtLocal: new Date().toISOString()
    };
  }

  function renderAfterLoad() {
    try { if (typeof window._sheetsBooted !== 'undefined') window._sheetsBooted = true; } catch (e) {}
    try { document.querySelectorAll('.folha-content').forEach(function (el) { el.remove(); }); } catch (e) {}
    try { window.activeId = null; } catch (e) {}
    try { if (typeof window.renderTabs === 'function') window.renderTabs(); } catch (e) {}
    try {
      const s = getSheetsLocal();
      if (s && s.length && typeof window.setActive === 'function') window.setActive(s[0].id);
    } catch (e) { warn('Falha ao ativar primeira folha:', e); }
    try {
      if (typeof window.dbRenderList === 'function') window.dbRenderList();
      else if (typeof window.showDashboard === 'function') window.showDashboard();
    } catch (e) { warn('Falha ao renderizar dashboard:', e); }
    // Atualiza o botão de usuário (se o sistema de login estiver presente).
    try { if (typeof window.__updateUserBtn === 'function') window.__updateUserBtn(); } catch (e) {}
  }

  function applyCloudState(data) {
    if (!data || typeof data !== 'object') return;
    applyingCloud = true;
    try {
      if (Array.isArray(data.sheets)) setSheetsLocal(data.sheets);
      if (data.pmData && typeof data.pmData === 'object') setPmLocal(data.pmData);
      if (data.clientLogos && typeof data.clientLogos === 'object') setLogosLocal(data.clientLogos);
      renderAfterLoad();
      log('Dados carregados do Firestore.');
    } finally {
      setTimeout(function () { applyingCloud = false; }, 400);
    }
  }

  function queueCloudSave(reason) {
    if (!cloudReady || !stateRef || applyingCloud) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      setDoc(stateRef, buildState(), { merge: true })
        .then(function () { log('Salvo na nuvem:', reason || 'auto'); })
        .catch(function (err) { warn('Erro ao salvar na nuvem:', err); });
    }, 700);
  }

  function patchLocalFunctions() {
    const originalSaveSheets        = (typeof window.saveSheets === 'function')        ? window.saveSheets        : null;
    const originalSalvarAgora       = (typeof window.salvarAgora === 'function')       ? window.salvarAgora       : null;
    const originalPmSave            = (typeof window.pmSave === 'function')            ? window.pmSave            : null;
    const originalPmLoad            = (typeof window.pmLoad === 'function')            ? window.pmLoad            : null;
    const originalDbSaveClientLogos = (typeof window.dbSaveClientLogos === 'function') ? window.dbSaveClientLogos : null;
    const originalDbGetClientLogos  = (typeof window.dbGetClientLogos === 'function')  ? window.dbGetClientLogos  : null;

    window.mtmForceCloudSave = function () {
      if (!stateRef) { toast('Firestore ainda não está pronto.', true); return; }
      return setDoc(stateRef, buildState(), { merge: true })
        .then(function () { toast('Salvo na nuvem.'); })
        .catch(function (err) { console.error(err); toast('Erro ao salvar na nuvem: ' + err.message, true); });
    };

    window.saveSheets = function () {
      if (originalSaveSheets) originalSaveSheets();
      queueCloudSave('saveSheets');
    };
    window.salvarAgora = function () {
      if (originalSalvarAgora) originalSalvarAgora();
      queueCloudSave('salvarAgora');
      setTimeout(window.mtmForceCloudSave, 50);
    };
    window.pmSave = function () {
      if (originalPmSave) originalPmSave();
      else setPmLocal(getPmLocal());
      queueCloudSave('pmSave');
    };
    window.pmLoad = function () {
      if (originalPmLoad) originalPmLoad();
      const obj = safeJsonGet(PM_KEY, {});
      try { if (typeof window.pmData !== 'undefined') window.pmData = obj || {}; } catch (e) {}
      return obj || {};
    };
    window.dbGetClientLogos = function () {
      if (originalDbGetClientLogos) { try { return originalDbGetClientLogos(); } catch (e) {} }
      return getLogosLocal();
    };
    window.dbSaveClientLogos = function (obj) {
      if (originalDbSaveClientLogos) originalDbSaveClientLogos(obj);
      else setLogosLocal(obj);
      queueCloudSave('clientLogos');
    };

    log('Funções locais conectadas ao Firestore.');
  }

  async function startFirebase() {
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey || String(cfg.apiKey).indexOf('COLE') === 0) {
      warn('window.FIREBASE_CONFIG ausente ou incompleto no index.html.');
      toast('Firebase: configuração ausente/incompleta no index.html.', true);
      if (typeof window.showDashboard === 'function') window.showDashboard();
      return;
    }

    const app = getApps().length ? getApps()[0] : initializeApp(cfg);
    db = getFirestore(app);

    // Auth anônimo simplifica as regras e sincroniza sem tela de login.
    try {
      await signInAnonymously(getAuth(app));
      log('Auth anônimo OK.');
    } catch (e) {
      warn('Auth anônimo falhou. Ative Authentication > Sign-in method > Anonymous e ajuste as regras.', e);
      toast('Firebase: login anônimo falhou — ative "Anonymous" no Authentication.', true);
    }

    stateRef = doc(db, STATE_COLLECTION, STATE_DOC);

    try {
      const snap = await getDoc(stateRef);
      if (snap.exists()) {
        applyCloudState(snap.data());
      } else if (localHasUsefulData()) {
        await setDoc(stateRef, buildState(), { merge: true });
        log('Firestore estava vazio. Dados locais enviados para a nuvem.');
      } else {
        log('Firestore vazio e local vazio. Nada para carregar ainda.');
      }
    } catch (err) {
      warn('Falha ao ler o documento do Firestore (verifique as regras/segurança):', err);
      toast('Firebase: sem permissão para ler os dados — verifique as regras do Firestore.', true);
      if (typeof window.showDashboard === 'function') window.showDashboard();
      return;
    }

    cloudReady = true;

    // Tempo real: quando outro navegador salvar, este recebe.
    onSnapshot(stateRef, function (snap) {
      if (!snap.exists() || applyingCloud) return;
      applyCloudState(snap.data());
    }, function (err) { warn('Listener Firestore falhou:', err); });

    if (typeof window.showDashboard === 'function') window.showDashboard();
  }

  function boot() {
    patchLocalFunctions();
    startFirebase().catch(function (err) {
      console.error('[MTM Firebase] erro crítico:', err);
      toast('Erro ao iniciar Firebase: ' + (err && err.message ? err.message : err), true);
      if (typeof window.showDashboard === 'function') window.showDashboard();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
