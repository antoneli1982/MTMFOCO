/* firebase-mtm.js — MTM EM FOCO — sincronização Firestore
   Substitui o arquivo atual.
   IMPORTANTE: preencha firebaseConfig com os dados do seu projeto Firebase.
*/
(function () {
  'use strict';

  // ============================================================
  // 1) CONFIGURAÇÃO FIREBASE
  // Cole aqui o objeto firebaseConfig do Firebase Console:
  // Project settings > General > Your apps > Web app > SDK setup and configuration
  // ============================================================
  const firebaseConfig = {
    apiKey: "COLE_AQUI",
    authDomain: "mtm-em-foco.firebaseapp.com",
    projectId: "mtm-em-foco",
    storageBucket: "mtm-em-foco.appspot.com",
    messagingSenderId: "COLE_AQUI",
    appId: "COLE_AQUI"
  };

  // Documento único compartilhado por todos os navegadores.
  // Se quiser separar por usuário no futuro, troque por users/{uid}/state/main.
  const STATE_COLLECTION = 'mtm_sync';
  const STATE_DOC = 'global_state';

  const SHEETS_KEY = 'mtm_sheets_v1';
  const PM_KEY = 'pmgr_v3';
  const LOGOS_KEY = 'mtm_client_logos_v1';

  let db = null;
  let stateRef = null;
  let cloudReady = false;
  let applyingCloud = false;
  let saveTimer = null;

  function log() {
    console.log.apply(console, ['[MTM Firebase]'].concat([].slice.call(arguments)));
  }

  function warn() {
    console.warn.apply(console, ['[MTM Firebase]'].concat([].slice.call(arguments)));
  }

  function safeJsonGet(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || '') || fallback;
    } catch (e) {
      return fallback;
    }
  }

  function safeJsonSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      warn('Falha ao salvar localStorage:', key, e);
    }
  }

  function getSheetsLocal() {
    try {
      if (typeof sheets !== 'undefined' && Array.isArray(sheets)) return sheets;
    } catch (e) {}
    return safeJsonGet(SHEETS_KEY, []);
  }

  function setSheetsLocal(arr) {
    const clean = Array.isArray(arr) ? arr : [];
    try {
      if (typeof sheets !== 'undefined') {
        sheets = clean;
      }
    } catch (e) {}
    safeJsonSet(SHEETS_KEY, clean);
  }

  function getPmLocal() {
    try {
      if (typeof pmData !== 'undefined' && pmData && typeof pmData === 'object') return pmData;
    } catch (e) {}
    return safeJsonGet(PM_KEY, {});
  }

  function setPmLocal(obj) {
    const clean = obj && typeof obj === 'object' ? obj : {};
    try {
      if (typeof pmData !== 'undefined') {
        pmData = clean;
      }
    } catch (e) {}
    safeJsonSet(PM_KEY, clean);
  }

  function getLogosLocal() {
    return safeJsonGet(LOGOS_KEY, {});
  }

  function setLogosLocal(obj) {
    safeJsonSet(LOGOS_KEY, obj && typeof obj === 'object' ? obj : {});
  }

  function localHasUsefulData() {
    const s = getSheetsLocal();
    const p = getPmLocal();
    const l = getLogosLocal();
    return (Array.isArray(s) && s.length > 0) ||
           (p && typeof p === 'object' && Object.keys(p).length > 0) ||
           (l && typeof l === 'object' && Object.keys(l).length > 0);
  }

  function buildState() {
    return {
      sheets: getSheetsLocal(),
      pmData: getPmLocal(),
      clientLogos: getLogosLocal(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAtLocal: new Date().toISOString()
    };
  }

  function renderAfterLoad() {
    try {
      if (typeof _sheetsBooted !== 'undefined') _sheetsBooted = true;
    } catch (e) {}

    try {
      document.querySelectorAll('.folha-content').forEach(function (el) { el.remove(); });
    } catch (e) {}

    try {
      activeId = null;
    } catch (e) {}

    try {
      if (typeof renderTabs === 'function') renderTabs();
    } catch (e) {}

    try {
      const s = getSheetsLocal();
      if (s && s.length && typeof setActive === 'function') {
        setActive(s[0].id);
      }
    } catch (e) {
      warn('Falha ao ativar primeira folha:', e);
    }

    try {
      if (typeof dbRenderList === 'function') dbRenderList();
      else if (typeof showDashboard === 'function') showDashboard();
    } catch (e) {
      warn('Falha ao renderizar dashboard:', e);
    }
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
      stateRef.set(buildState(), { merge: true })
        .then(function () { log('Salvo na nuvem:', reason || 'auto'); })
        .catch(function (err) { warn('Erro ao salvar na nuvem:', err); });
    }, 700);
  }

  function patchLocalFunctions() {
    // Guarda originais
    const originalSaveSheets = (typeof saveSheets === 'function') ? saveSheets : null;
    const originalSalvarAgora = (typeof salvarAgora === 'function') ? salvarAgora : null;
    const originalPmSave = (typeof pmSave === 'function') ? pmSave : null;
    const originalPmLoad = (typeof pmLoad === 'function') ? pmLoad : null;
    const originalDbSaveClientLogos = (typeof dbSaveClientLogos === 'function') ? dbSaveClientLogos : null;
    const originalDbGetClientLogos = (typeof dbGetClientLogos === 'function') ? dbGetClientLogos : null;

    window.mtmForceCloudSave = function () {
      if (!stateRef) {
        alert('Firestore ainda não está pronto.');
        return;
      }
      return stateRef.set(buildState(), { merge: true })
        .then(function () {
          if (typeof showToast === 'function') showToast('Salvo na nuvem.');
          else alert('Salvo na nuvem.');
        })
        .catch(function (err) {
          console.error(err);
          alert('Erro ao salvar na nuvem: ' + err.message);
        });
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
      try {
        if (typeof pmData !== 'undefined') pmData = obj || {};
      } catch (e) {}
      return obj || {};
    };

    window.dbGetClientLogos = function () {
      if (originalDbGetClientLogos) {
        try { return originalDbGetClientLogos(); } catch (e) {}
      }
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
    if (typeof firebase === 'undefined') {
      warn('SDK Firebase não carregou. Confira os scripts do index.html.');
      if (typeof showDashboard === 'function') showDashboard();
      return;
    }

    if (!firebaseConfig.apiKey || firebaseConfig.apiKey === 'COLE_AQUI') {
      warn('Preencha firebaseConfig em firebase-mtm.js antes de publicar.');
      alert('Falta preencher o firebaseConfig no arquivo firebase-mtm.js.');
      if (typeof showDashboard === 'function') showDashboard();
      return;
    }

    if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();

    // Auth anônimo simplifica as regras e permite sincronizar sem tela de login.
    try {
      await firebase.auth().signInAnonymously();
      log('Auth anônimo OK.');
    } catch (e) {
      warn('Auth anônimo falhou. Ative Authentication > Sign-in method > Anonymous, ou ajuste as regras do Firestore.', e);
    }

    stateRef = db.collection(STATE_COLLECTION).doc(STATE_DOC);

    const snap = await stateRef.get();

    if (snap.exists) {
      applyCloudState(snap.data());
    } else if (localHasUsefulData()) {
      await stateRef.set(buildState(), { merge: true });
      log('Firestore estava vazio. Dados locais enviados para a nuvem.');
    } else {
      log('Firestore vazio e local vazio.');
    }

    cloudReady = true;

    // Atualização em tempo real: quando outro navegador salvar, este recebe.
    stateRef.onSnapshot(function (doc) {
      if (!doc.exists || applyingCloud) return;
      applyCloudState(doc.data());
    }, function (err) {
      warn('Listener Firestore falhou:', err);
    });

    if (typeof showDashboard === 'function') showDashboard();
  }

  document.addEventListener('DOMContentLoaded', function () {
    patchLocalFunctions();
    startFirebase().catch(function (err) {
      console.error('[MTM Firebase] erro crítico:', err);
      alert('Erro ao iniciar Firebase: ' + err.message);
      if (typeof showDashboard === 'function') showDashboard();
    });
  });

})();
