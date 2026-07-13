/* firebase-mtm.js — MTM EM FOCO — sincronização via REALTIME DATABASE (Firebase v10 modular / ESM)
   ------------------------------------------------------------------------------------
   Esta versão usa o REALTIME DATABASE (não o Firestore), porque é o banco que o seu
   projeto já tem configurado (databaseURL "...-default-rtdb..." e regras ".read"/".write").
   Lê as credenciais de window.FIREBASE_CONFIG (definido no index.html).

   >>> IMPORTANTE — no Console do Firebase (senão continua "sem permissão"):
     1) Realtime Database > aba REGRAS (Rules) > cole e PUBLIQUE:

            {
              "rules": {
                "mtm_sync": {
                  ".read":  "auth != null",
                  ".write": "auth != null"
                }
              }
            }

     2) Authentication > Sign-in method > Anonymous (Anônimo) > ATIVAR.

   (Para um TESTE rápido você pode usar ".read": true / ".write": true, mas isso deixa
    o banco ABERTO para qualquer um. Volte para "auth != null" depois do teste.)
   ------------------------------------------------------------------------------------
   OBS de segurança: a apiKey do Firebase Web é pública por natureza; a proteção real
   vem das REGRAS do banco, não do sigilo da chave.
*/

// Se esta versão exata não existir no gstatic, troque o número (ex.: 10.12.0, 10.13.0...).
import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase, ref, get, set, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

(function () {
  'use strict';

  // Caminho único compartilhado por todos os navegadores.
  const STATE_PATH = 'mtm_sync/global_state';

  // Mesmas chaves de localStorage usadas pelo app.
  const SHEETS_KEY = 'mtm_sheets_v1';
  const PM_KEY = 'pmgr_v3';
  const LOGOS_KEY = 'mtm_client_logos_v1';

  let dbRef = null;
  let cloudReady = false;
  let applyingCloud = false;
  let saveTimer = null;

  function log()  { console.log.apply(console, ['[MTM Firebase]'].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, ['[MTM Firebase]'].concat([].slice.call(arguments))); }

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

  // Realtime Database às vezes devolve arrays como objeto {0:..,1:..}. Isto normaliza de volta.
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const keys = Object.keys(v);
      if (keys.length && keys.every(function (k) { return /^\d+$/.test(k); })) {
        return keys.sort(function (a, b) { return (+a) - (+b); }).map(function (k) { return v[k]; });
      }
    }
    return null;
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
      updatedAt: Date.now(),
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
    try { if (typeof window.__updateUserBtn === 'function') window.__updateUserBtn(); } catch (e) {}
  }

  function applyCloudState(data) {
    if (!data || typeof data !== 'object') return;
    applyingCloud = true;
    try {
      const sheetsArr = asArray(data.sheets);
      if (sheetsArr) setSheetsLocal(sheetsArr);
      if (data.pmData && typeof data.pmData === 'object') setPmLocal(data.pmData);
      if (data.clientLogos && typeof data.clientLogos === 'object') setLogosLocal(data.clientLogos);
      renderAfterLoad();
      log('Dados carregados do Realtime Database.');
    } finally {
      setTimeout(function () { applyingCloud = false; }, 400);
    }
  }

  function queueCloudSave(reason) {
    if (!cloudReady || !dbRef || applyingCloud) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      set(dbRef, buildState())
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
      if (!dbRef) { toast('Banco ainda não está pronto.', true); return; }
      return set(dbRef, buildState())
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

    log('Funções locais conectadas ao Realtime Database.');
  }

  async function startFirebase() {
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey || String(cfg.apiKey).indexOf('COLE') === 0) {
      warn('window.FIREBASE_CONFIG ausente ou incompleto no index.html.');
      toast('Firebase: configuração ausente/incompleta no index.html.', true);
      if (typeof window.showDashboard === 'function') window.showDashboard();
      return;
    }
    if (!cfg.databaseURL) {
      warn('Falta databaseURL em window.FIREBASE_CONFIG (necessário para Realtime Database).');
      toast('Firebase: falta o databaseURL no index.html (Realtime Database).', true);
      if (typeof window.showDashboard === 'function') window.showDashboard();
      return;
    }

    const app = getApps().length ? getApps()[0] : initializeApp(cfg);
    const db = getDatabase(app);

    // Auth anônimo (necessário para a regra "auth != null").
    try {
      await signInAnonymously(getAuth(app));
      log('Auth anônimo OK.');
    } catch (e) {
      warn('Auth anônimo falhou. Ative Authentication > Sign-in method > Anonymous.', e);
      toast('Firebase: login anônimo falhou — ative "Anonymous" no Authentication.', true);
    }

    dbRef = ref(db, STATE_PATH);

    try {
      const snap = await get(dbRef);
      if (snap.exists()) {
        applyCloudState(snap.val());
      } else if (localHasUsefulData()) {
        await set(dbRef, buildState());
        log('Nuvem estava vazia. Dados locais enviados para a nuvem.');
      } else {
        log('Nuvem vazia e local vazio. Nada para carregar ainda.');
      }
    } catch (err) {
      warn('Falha ao ler o Realtime Database (verifique as regras):', err);
      toast('Firebase: sem permissão para ler os dados — verifique as regras do Realtime Database.', true);
      if (typeof window.showDashboard === 'function') window.showDashboard();
      return;
    }

    cloudReady = true;

    // Tempo real: quando outro navegador salvar, este recebe.
    onValue(dbRef, function (snap) {
      if (!snap.exists() || applyingCloud) return;
      applyCloudState(snap.val());
    }, function (err) { warn('Listener Realtime Database falhou:', err); });

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
