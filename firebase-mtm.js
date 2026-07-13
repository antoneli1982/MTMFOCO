/* firebase-mtm.js — MTM EM FOCO — CLOUD FIRESTORE (recuperar + salvar)
   ------------------------------------------------------------------------------------
   Esta versão usa o CLOUD FIRESTORE, onde estão os seus dados de verdade, nas coleções:
     - projects : pastas/empresas  -> cada doc = { id:"f_...", name, logo, projects:[ {id:"p_...", name, client, date, img, logo, notes, sheets:["sh..."]} ] }
     - sheets   : folhas           -> cada doc = { id:"sh...", label, order, header{...}, rows[...], book, fadiga }
     - logos    : logos por cliente-> cada doc = { client, dataUrl }

   Ela RECUPERA esses dados para dentro da ferramenta (pmData, sheets, clientLogos) e
   CONTINUA SALVANDO de volta no mesmo formato (um documento por item), com proteções
   para não apagar seus dados por engano.

   Config: window.FIREBASE_CONFIG (definido no index.html).

   >>> REQUISITOS no Console do Firebase:
     1) Authentication > Sign-in method > Anonymous (Anônimo): ATIVADO (já está no seu projeto).
     2) FIRESTORE Database > aba REGRAS (Rules) > publicar (é a sintaxe do Firestore, NÃO a do Realtime):

            rules_version = '2';
            service cloud.firestore {
              match /databases/{database}/documents {
                match /{document=**} {
                  allow read, write: if request.auth != null;
                }
              }
            }
   ------------------------------------------------------------------------------------
   OBS de segurança: a apiKey do Firebase Web é pública por natureza; a proteção real
   vem das REGRAS do Firestore, não do sigilo da chave.
*/

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, getDocs, doc, setDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

(function () {
  'use strict';

  const COL_PROJECTS = 'projects';   // pastas/empresas
  const COL_SHEETS   = 'sheets';     // folhas
  const COL_LOGOS    = 'logos';      // logos por cliente

  const SHEETS_KEY = 'mtm_sheets_v1';
  const PM_KEY     = 'pmgr_v3';
  const LOGOS_KEY  = 'mtm_client_logos_v1';

  let db = null;
  let uid = null;
  let cloudReady = false;      // só vira true APÓS uma leitura bem-sucedida (protege os dados)
  let applyingCloud = false;
  let saveTimer = null;

  // Caches do que já está na nuvem (para gravar só o que mudou e detectar remoções).
  const syncedSheets  = {};
  const syncedFolders = {};
  const syncedLogos   = {};

  function log()  { console.log.apply(console, ['[MTM Firebase]'].concat([].slice.call(arguments))); }
  function warn() { console.warn.apply(console, ['[MTM Firebase]'].concat([].slice.call(arguments))); }
  function wErr(err) { warn('Erro ao gravar no Firestore:', err); }

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

  // Firestore doc id não pode ter / \ . # $ [ ] — usado só para a coleção de logos.
  function logoDocId(client) {
    var id = String(client == null ? '' : client).replace(/[\/\\.#$\[\]]/g, '_').slice(0, 300);
    return id || '_';
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

  // ---------- LEITURA (recuperar) ----------
  async function loadAll() {
    const results = await Promise.all([
      getDocs(collection(db, COL_PROJECTS)),
      getDocs(collection(db, COL_SHEETS)),
      getDocs(collection(db, COL_LOGOS))
    ]);
    const pSnap = results[0], sSnap = results[1], lSnap = results[2];

    // sheets -> array de folhas
    const sheetsArr = [];
    sSnap.forEach(function (d) {
      const o = d.data() || {};
      if (!o.id) o.id = d.id;
      sheetsArr.push(o);
    });
    sheetsArr.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });

    // projects -> pmData { folderId: { name, logo, projects:[...] } }
    const pmObj = {};
    pSnap.forEach(function (d) {
      const o = d.data() || {};
      const id = o.id || d.id;
      const v = Object.assign({}, o);
      delete v.id;
      if (!Array.isArray(v.projects)) v.projects = v.projects ? v.projects : [];
      pmObj[id] = v;
    });

    // logos -> { client: dataUrl }
    const logosObj = {};
    lSnap.forEach(function (d) {
      const o = d.data() || {};
      const client = o.client || d.id;
      if (client) logosObj[client] = o.dataUrl || o.logo || '';
    });

    return { sheetsArr: sheetsArr, pmObj: pmObj, logosObj: logosObj };
  }

  function applyFromCloud(sheetsArr, pmObj, logosObj) {
    applyingCloud = true;
    try {
      setSheetsLocal(sheetsArr);
      setPmLocal(pmObj);
      setLogosLocal(logosObj);

      // Popular caches para o primeiro save NÃO reescrever tudo.
      Object.keys(syncedSheets).forEach(function (k) { delete syncedSheets[k]; });
      sheetsArr.forEach(function (sh) { if (sh && sh.id) syncedSheets[sh.id] = JSON.stringify(sh); });

      Object.keys(syncedFolders).forEach(function (k) { delete syncedFolders[k]; });
      Object.keys(pmObj).forEach(function (fid) { syncedFolders[fid] = JSON.stringify(Object.assign({ id: fid }, pmObj[fid])); });

      Object.keys(syncedLogos).forEach(function (k) { delete syncedLogos[k]; });
      Object.keys(logosObj).forEach(function (c) { syncedLogos[logoDocId(c)] = JSON.stringify({ client: c, dataUrl: logosObj[c] }); });

      renderAfterLoad();
      log('Dados recuperados do Firestore: ' + sheetsArr.length + ' folha(s), ' +
          Object.keys(pmObj).length + ' pasta(s), ' + Object.keys(logosObj).length + ' logo(s).');
    } finally {
      setTimeout(function () { applyingCloud = false; }, 500);
    }
  }

  // ---------- ESCRITA (salvar de volta) ----------
  function syncToCloud() {
    if (!cloudReady || !db || applyingCloud) return;
    try {
      // ----- SHEETS -----
      const sArr = getSheetsLocal();
      const curS = {};
      sArr.forEach(function (sh) {
        if (!sh || !sh.id) return;
        curS[sh.id] = 1;
        const js = JSON.stringify(sh);
        if (syncedSheets[sh.id] !== js) {
          syncedSheets[sh.id] = js;
          setDoc(doc(db, COL_SHEETS, String(sh.id)), sh).catch(wErr);
        }
      });
      // remoções (proteção: não apaga tudo se a lista vier vazia por engano)
      const knownS = Object.keys(syncedSheets);
      if (!(sArr.length === 0 && knownS.length > 0)) {
        knownS.forEach(function (id) {
          if (!curS[id]) { delete syncedSheets[id]; deleteDoc(doc(db, COL_SHEETS, String(id))).catch(wErr); }
        });
      } else {
        warn('Ignorando remoção em massa de folhas (lista local vazia) — proteção de dados.');
      }

      // ----- FOLDERS (pmData) -----
      const pm = getPmLocal();
      const curF = {};
      Object.keys(pm).forEach(function (fid) {
        curF[fid] = 1;
        const fd = Object.assign({ id: fid }, pm[fid]);
        const js = JSON.stringify(fd);
        if (syncedFolders[fid] !== js) {
          syncedFolders[fid] = js;
          setDoc(doc(db, COL_PROJECTS, String(fid)), fd).catch(wErr);
        }
      });
      const knownF = Object.keys(syncedFolders);
      if (!(Object.keys(pm).length === 0 && knownF.length > 0)) {
        knownF.forEach(function (fid) {
          if (!curF[fid]) { delete syncedFolders[fid]; deleteDoc(doc(db, COL_PROJECTS, String(fid))).catch(wErr); }
        });
      } else {
        warn('Ignorando remoção em massa de pastas (pmData vazio) — proteção de dados.');
      }

      // ----- LOGOS -----
      const lg = getLogosLocal();
      const curL = {};
      Object.keys(lg).forEach(function (client) {
        const id = logoDocId(client);
        curL[id] = 1;
        const cmp = JSON.stringify({ client: client, dataUrl: lg[client] });
        if (syncedLogos[id] !== cmp) {
          syncedLogos[id] = cmp;
          setDoc(doc(db, COL_LOGOS, id), { client: client, dataUrl: lg[client], updatedAt: serverTimestamp(), updatedBy: uid || '' }).catch(wErr);
        }
      });
      const knownL = Object.keys(syncedLogos);
      if (!(Object.keys(lg).length === 0 && knownL.length > 0)) {
        knownL.forEach(function (id) {
          if (!curL[id]) { delete syncedLogos[id]; deleteDoc(doc(db, COL_LOGOS, id)).catch(wErr); }
        });
      }
    } catch (e) {
      warn('Falha ao sincronizar com o Firestore:', e);
    }
  }

  function queueCloudSave(reason) {
    if (!cloudReady || applyingCloud) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      syncToCloud();
      log('Sincronizado (' + (reason || 'auto') + ').');
    }, 800);
  }

  function patchLocalFunctions() {
    const originalSaveSheets        = (typeof window.saveSheets === 'function')        ? window.saveSheets        : null;
    const originalSalvarAgora       = (typeof window.salvarAgora === 'function')       ? window.salvarAgora       : null;
    const originalPmSave            = (typeof window.pmSave === 'function')            ? window.pmSave            : null;
    const originalPmLoad            = (typeof window.pmLoad === 'function')            ? window.pmLoad            : null;
    const originalDbSaveClientLogos = (typeof window.dbSaveClientLogos === 'function') ? window.dbSaveClientLogos : null;
    const originalDbGetClientLogos  = (typeof window.dbGetClientLogos === 'function')  ? window.dbGetClientLogos  : null;

    window.mtmForceCloudSave = function () {
      if (!cloudReady) { toast('Ainda carregando/sem permissão — não é seguro salvar agora.', true); return; }
      syncToCloud();
      toast('Salvo na nuvem.');
    };

    window.saveSheets = function () {
      if (originalSaveSheets) originalSaveSheets();
      queueCloudSave('saveSheets');
    };
    window.salvarAgora = function () {
      if (originalSalvarAgora) originalSalvarAgora();
      queueCloudSave('salvarAgora');
      setTimeout(window.mtmForceCloudSave, 60);
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

  async function start() {
    const cfg = window.FIREBASE_CONFIG;
    if (!cfg || !cfg.apiKey || String(cfg.apiKey).indexOf('COLE') === 0) {
      warn('window.FIREBASE_CONFIG ausente ou incompleto no index.html.');
      toast('Firebase: configuração ausente/incompleta no index.html.', true);
      if (typeof window.showDashboard === 'function') window.showDashboard();
      return;
    }

    const app = getApps().length ? getApps()[0] : initializeApp(cfg);
    db = getFirestore(app);

    try {
      const cred = await signInAnonymously(getAuth(app));
      uid = (cred && cred.user) ? cred.user.uid : null;
      log('Auth anônimo OK.');
    } catch (e) {
      warn('Auth anônimo falhou. Ative Authentication > Sign-in method > Anonymous.', e);
      toast('Firebase: login anônimo falhou — ative "Anonymous" no Authentication.', true);
    }

    try {
      const data = await loadAll();
      applyFromCloud(data.sheetsArr, data.pmObj, data.logosObj);
    } catch (err) {
      warn('Falha ao ler o Firestore (verifique as REGRAS do FIRESTORE):', err);
      toast('Firebase: sem permissão para ler os dados — verifique as regras do FIRESTORE.', true);
      if (typeof window.showDashboard === 'function') window.showDashboard();
      return; // NÃO habilita o salvamento -> protege seus dados de serem sobrescritos.
    }

    cloudReady = true; // só agora o salvamento fica ativo
    if (typeof window.showDashboard === 'function') window.showDashboard();
  }

  function boot() {
    patchLocalFunctions();
    start().catch(function (err) {
      console.error('[MTM Firebase] erro crítico:', err);
      toast('Erro ao iniciar Firebase: ' + (err && err.message ? err.message : err), true);
      if (typeof window.showDashboard === 'function') window.showDashboard();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
