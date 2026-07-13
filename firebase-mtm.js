/* ============================================================================
   firebase-mtm.js — MTM EM FOCO
   SISTEMA DE PAPÉIS DE ACESSO + SEPARAÇÃO REAL POR USUÁRIO (Firestore)

   O que este arquivo faz:
   - Login por CÓDIGO (a mesma tela de "chapa"). O código define o papel.
   - Cada pessoa tem o SEU documento no Firestore: mtm_users/{codigo}
     contendo { sheets, pmData, clientLogos, name, role }.
   - Ao entrar, carrega SÓ o que a pessoa pode ver (o seu + o permitido).
   - Ao salvar, grava SÓ nos documentos que a pessoa pode editar.
   - Folhas que a pessoa só pode VER entram em modo "somente leitura".

   IMPORTANTE (segurança — leia): o login é por código digitado e o Firebase
   usa auth ANÔNIMO. Portanto a separação é garantida PELO APP, não pelo
   servidor. Alguém técnico consegue ler o banco direto. Para blindar de
   verdade é preciso Firebase Authentication (conta real) + Regras do
   Firestore por usuário. Veja o README que acompanha a entrega.
   ============================================================================ */
(function () {
  'use strict';

  /* ==========================================================================
     1) CONFIGURAÇÃO DE PAPÉIS  —  EDITE AQUI (é só esta parte)
     ========================================================================== */

  // Código do dono absoluto (Felipe). Ninguém, nem o sênior, mexe nas folhas dele.
  var OWNER_CODE = '0000001';

  // Código do sênior. Edita/exclui tudo, EXCETO as folhas do Felipe.
  var SENIOR_CODE = '321215';

  // Códigos dos "apresentados": controle total das PRÓPRIAS folhas + veem
  // (somente leitura) as folhas do sênior. NÃO veem as do Felipe.
  // Obs.: no pedido original apareceu "00000002" (8 dígitos). Deixei as duas
  // formas para ninguém ficar travado. Ajuste à vontade.
  var APRESENTADOS = ['0000002', '00000002', '0000003'];

  // Nomes só para exibição (opcional).
  var NAMES = {
    '0000001': 'FELIPE',
    '321215':  'SÊNIOR',
    '0000002': 'APRESENTADO 2',
    '00000002':'APRESENTADO 2',
    '0000003': 'APRESENTADO 3'
  };

  // Mensagem de boas-vindas do dono.
  var OWNER_WELCOME = 'SEJA BEM VINDO MEU IRMÃO ENGº FELIPE';

  /* ==========================================================================
     2) CONFIGURAÇÃO FIREBASE
     Usa a config do index.html (window.FIREBASE_CONFIG). Se não existir,
     cai para o objeto abaixo (preencha se for usar sem o index).
     ========================================================================== */
  var LOCAL_CONFIG = {
    apiKey: 'COLE_AQUI',
    authDomain: 'mtm-em-foco.firebaseapp.com',
    projectId: 'mtm-em-foco',
    storageBucket: 'mtm-em-foco.appspot.com',
    messagingSenderId: 'COLE_AQUI',
    appId: 'COLE_AQUI'
  };

  function getFirebaseConfig() {
    try {
      if (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey &&
          window.FIREBASE_CONFIG.apiKey !== 'COLE_AQUI') {
        return window.FIREBASE_CONFIG;
      }
    } catch (e) {}
    return LOCAL_CONFIG;
  }

  // Coleção onde ficam os documentos por usuário.
  var USERS_COLLECTION = 'mtm_users';

  // Chaves de localStorage já usadas pelo app.
  var SHEETS_KEY = 'mtm_sheets_v1';
  var PM_KEY = 'pmgr_v3';
  var LOGOS_KEY = 'mtm_client_logos_v1';

  /* ==========================================================================
     3) ESTADO INTERNO
     ========================================================================== */
  var db = null;
  var cloudReady = false;      // Firestore inicializado
  var applyingCloud = false;   // estamos aplicando dados vindos da nuvem (evita eco)
  var saveTimer = null;
  var liveUnsub = null;        // função para cancelar o listener em tempo real
  var readyResolve = null;
  var readyPromise = new Promise(function (res) { readyResolve = res; });

  var CURRENT = null;          // { code, role, name }
  var ownerMeta = {};          // { code: { name, role } } — capturado no load

  function log()  { try { console.log.apply(console,  ['[MTM]'].concat([].slice.call(arguments))); } catch (e) {} }
  function warn() { try { console.warn.apply(console, ['[MTM]'].concat([].slice.call(arguments))); } catch (e) {} }

  /* ==========================================================================
     4) HELPERS DE localStorage / ESTADO LOCAL
     ========================================================================== */
  function safeJsonGet(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || '') || fallback; }
    catch (e) { return fallback; }
  }
  function safeJsonSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { warn('Falha localStorage:', key, e); }
  }

  function getSheetsLocal() {
    try { if (typeof sheets !== 'undefined' && Array.isArray(sheets)) return sheets; } catch (e) {}
    return safeJsonGet(SHEETS_KEY, []);
  }
  function setSheetsInMemory(arr) {
    var clean = Array.isArray(arr) ? arr : [];
    try {
      if (typeof sheets !== 'undefined' && Array.isArray(sheets)) {
        sheets.length = 0;
        Array.prototype.push.apply(sheets, clean);   // preserva a referência do array global
      } else {
        window.sheets = clean;
      }
    } catch (e) { try { window.sheets = clean; } catch (e2) {} }
    safeJsonSet(SHEETS_KEY, clean);
  }

  function getPmLocal() {
    try { if (typeof pmData !== 'undefined' && pmData && typeof pmData === 'object') return pmData; } catch (e) {}
    return safeJsonGet(PM_KEY, {});
  }
  function setPmInMemory(obj) {
    var clean = (obj && typeof obj === 'object') ? obj : {};
    try {
      if (typeof pmData !== 'undefined' && pmData && typeof pmData === 'object') {
        Object.keys(pmData).forEach(function (k) { delete pmData[k]; });
        Object.assign(pmData, clean);
      } else {
        window.pmData = clean;
      }
    } catch (e) { try { window.pmData = clean; } catch (e2) {} }
    safeJsonSet(PM_KEY, clean);
  }

  function getLogosLocal() { return safeJsonGet(LOGOS_KEY, {}); }
  function setLogosLocal(obj) { safeJsonSet(LOGOS_KEY, (obj && typeof obj === 'object') ? obj : {}); }

  function localHasUsefulData() {
    var s = getSheetsLocal(), p = getPmLocal();
    return (Array.isArray(s) && s.length > 0) ||
           (p && typeof p === 'object' && Object.keys(p).length > 0);
  }

  /* ==========================================================================
     5) PAPÉIS: resolução + permissões
     ========================================================================== */
  function roleFor(code) {
    if (code === OWNER_CODE) return 'owner';
    if (code === SENIOR_CODE) return 'senior';
    if (APRESENTADOS.indexOf(code) !== -1) return 'apresentado';
    return 'comum';
  }

  // A pessoa "u" pode EDITAR os dados cujo dono é "ownerCode"?
  function canEdit(u, ownerCode) {
    if (!u) return false;
    if (u.role === 'owner') return true;                       // Felipe edita tudo
    if (u.role === 'senior') return ownerCode !== OWNER_CODE;  // sênior: tudo menos Felipe
    return ownerCode === u.code;                               // apresentado/comum: só o próprio
  }

  // Quais donos a pessoa "u" pode VER? Retorna '*' (todos) ou uma lista de códigos.
  function visibleOwners(u) {
    if (!u) return [];
    if (u.role === 'owner') return '*';                        // vê todos
    if (u.role === 'senior') return '*_except_owner';          // todos menos Felipe
    if (u.role === 'apresentado') return [u.code, SENIOR_CODE];// o próprio + sênior (leitura)
    return [u.code];                                           // comum: só o próprio
  }

  /* ==========================================================================
     6) TAGS de dono/somente-leitura (só em memória; não vão limpas p/ nuvem)
     ========================================================================== */
  function tagSheet(s, code, ro) { s._owner = code; s._ro = ro; return s; }
  function stripSheet(s) {
    return {
      id: s.id, label: s.label, header: s.header || {},
      book: s.book || '', fadiga: s.fadiga || null,
      rows: (s.rows || []).map(function (r) {
        return {
          id: r.id, desc: r.desc || '', agrega: r.agrega || '', code: r.code || '',
          tmu: r.tmu || '', q: r.q || '', f: r.f || '',
          ttmu: r.ttmu || 0, tsec: r.tsec || 0
        };
      })
    };
  }
  function stripPm(pm) {
    var out = {};
    Object.keys(pm || {}).forEach(function (fid) {
      var f = pm[fid]; if (!f) return;
      var nf = { name: f.name, logo: f.logo || null, projects: [] };
      (f.projects || []).forEach(function (p) {
        var np = {}; Object.keys(p).forEach(function (k) {
          if (k === '_owner' || k === '_ro') return; np[k] = p[k];
        });
        nf.projects.push(np);
      });
      // preserva quaisquer outros campos do folder (menos as tags)
      Object.keys(f).forEach(function (k) {
        if (k === '_owner' || k === '_ro' || k === 'projects') return;
        if (!(k in nf)) nf[k] = f[k];
      });
      out[fid] = nf;
    });
    return out;
  }

  /* ==========================================================================
     7) APLICAR ESTADO NA TELA
     ========================================================================== */
  function renderAfterLoad() {
    try { document.querySelectorAll('.folha-content').forEach(function (el) { el.remove(); }); } catch (e) {}
    try { if (typeof activeId !== 'undefined') activeId = null; } catch (e) {}
    try { if (typeof renderTabs === 'function') renderTabs(); } catch (e) { warn('renderTabs falhou:', e); }
    try {
      var s = getSheetsLocal();
      if (s && s.length && typeof setActive === 'function') setActive(s[0].id);
    } catch (e) { warn('setActive falhou:', e); }
    try {
      if (typeof dbRenderList === 'function') dbRenderList();
      else if (typeof showDashboard === 'function') showDashboard();
    } catch (e) {}
  }

  // Constrói (sheets, pmData, logos) a partir de uma lista de documentos.
  function buildFromDocs(u, docs) {
    var mergedSheets = [], mergedPm = {}, mergedLogos = {};
    ownerMeta = {};
    docs.forEach(function (d) {
      var code = d.code, data = d.data || {};
      ownerMeta[code] = { name: data.name || NAMES[code] || code, role: data.role || roleFor(code) };
      var ro = !canEdit(u, code);
      (Array.isArray(data.sheets) ? data.sheets : []).forEach(function (s) {
        mergedSheets.push(tagSheet(s, code, ro));
      });
      var pm = (data.pmData && typeof data.pmData === 'object') ? data.pmData : {};
      Object.keys(pm).forEach(function (fid) {
        var f = pm[fid]; if (!f) return;
        f._owner = code; f._ro = ro;
        (f.projects || []).forEach(function (p) { p._owner = code; p._ro = ro; });
        mergedPm[fid] = f;   // ids de folder/sheet são únicos (gid + timestamp)
      });
      if (data.clientLogos && typeof data.clientLogos === 'object') Object.assign(mergedLogos, data.clientLogos);
    });
    return { sheets: mergedSheets, pmData: mergedPm, logos: mergedLogos };
  }

  function applyState(built) {
    applyingCloud = true;
    try {
      setSheetsInMemory(built.sheets);
      setPmInMemory(built.pmData);
      setLogosLocal(built.logos);
      renderAfterLoad();
      log('Dados aplicados. Folhas:', built.sheets.length);
    } finally {
      setTimeout(function () { applyingCloud = false; }, 400);
    }
  }

  /* ==========================================================================
     8) CARREGAR OS DOCUMENTOS PERMITIDOS PARA A PESSOA
     ========================================================================== */
  function fetchDocsFor(u) {
    var vis = visibleOwners(u);

    if (vis === '*' || vis === '*_except_owner') {
      // Precisa listar a coleção inteira.
      return db.collection(USERS_COLLECTION).get().then(function (snap) {
        var docs = [];
        snap.forEach(function (doc) {
          if (vis === '*_except_owner' && doc.id === OWNER_CODE) return; // sênior não vê Felipe
          docs.push({ code: doc.id, data: doc.data() });
        });
        // garante que o próprio doc apareça mesmo se ainda não existir
        if (!docs.some(function (d) { return d.code === u.code; })) docs.push({ code: u.code, data: {} });
        return docs;
      });
    }

    // Lista específica de códigos.
    var codes = vis.slice();
    if (codes.indexOf(u.code) === -1) codes.push(u.code);
    return Promise.all(codes.map(function (code) {
      return db.collection(USERS_COLLECTION).doc(code).get()
        .then(function (doc) { return { code: code, data: doc.exists ? doc.data() : {} }; })
        .catch(function () { return { code: code, data: {} }; });
    }));
  }

  function loadForUser() {
    if (!CURRENT) return Promise.resolve();
    var u = CURRENT;

    if (!cloudReady || !db) {
      // Sem nuvem: usa o que houver em localStorage, mas marca o que não é da
      // pessoa como somente leitura para não vazar edição.
      warn('Firestore indisponível — usando dados locais (modo offline).');
      var local = getSheetsLocal().map(function (s) {
        var owner = s._owner || u.code;
        return tagSheet(s, owner, !canEdit(u, owner));
      });
      applyState({ sheets: local, pmData: getPmLocal(), logos: getLogosLocal() });
      startLive();
      return Promise.resolve();
    }

    return fetchDocsFor(u)
      .then(function (docs) {
        // se a NUVEM está vazia para o próprio usuário e há dados locais úteis,
        // sobe os dados locais como sendo dele (primeira migração).
        var ownDoc = docs.filter(function (d) { return d.code === u.code; })[0];
        var ownEmpty = !ownDoc || !(ownDoc.data && ((ownDoc.data.sheets || []).length || Object.keys(ownDoc.data.pmData || {}).length));
        if (ownEmpty && localHasUsefulData()) {
          var localSheets = getSheetsLocal().filter(function (s) { return !s._owner || s._owner === u.code; });
          var localPm = getPmLocal();
          return writeOwnerDoc(u.code, localSheets, localPm, getLogosLocal())
            .then(function () { log('Migração: dados locais enviados para', u.code); return fetchDocsFor(u); });
        }
        return docs;
      })
      .then(function (docs) {
        applyState(buildFromDocs(u, docs));
        startLive();
      })
      .catch(function (err) {
        warn('Falha ao carregar da nuvem:', err);
        // fallback offline
        var local = getSheetsLocal().map(function (s) {
          var owner = s._owner || u.code;
          return tagSheet(s, owner, !canEdit(u, owner));
        });
        applyState({ sheets: local, pmData: getPmLocal(), logos: getLogosLocal() });
      });
  }

  /* ==========================================================================
     9) SALVAR — só nos documentos que a pessoa pode editar
     ========================================================================== */
  function writeOwnerDoc(code, sheetsArr, pmObj, logosObj) {
    if (!db) return Promise.reject(new Error('sem db'));
    var meta = ownerMeta[code] || {};
    var payload = {
      sheets: (sheetsArr || []).map(stripSheet),
      pmData: stripPm(pmObj || {}),
      name: meta.name || (code === (CURRENT && CURRENT.code) ? (CURRENT && CURRENT.name) : NAMES[code]) || code,
      role: meta.role || roleFor(code),
      updatedAtLocal: new Date().toISOString()
    };
    if (code === (CURRENT && CURRENT.code)) payload.clientLogos = getLogosLocal();
    // merge:false = substitui o documento daquele usuário pelo seu conjunto atual
    return db.collection(USERS_COLLECTION).doc(code).set(payload, { merge: false });
  }

  // Quais donos gravar nesta operação de save?
  function saveTargets(u) {
    var t = {}; t[u.code] = true; // sempre o próprio
    try {
      var act = (typeof get === 'function') ? get(activeId) : null;
      if (act && act._owner && canEdit(u, act._owner)) t[act._owner] = true;
    } catch (e) {}
    try {
      if (typeof getActiveProject === 'function') {
        var proj = getActiveProject();
        if (proj && proj._owner && canEdit(u, proj._owner)) t[proj._owner] = true;
      }
    } catch (e) {}
    return Object.keys(t).filter(function (code) { return canEdit(u, code); });
  }

  function cloudSaveScoped(reason) {
    if (!cloudReady || !db || applyingCloud || !CURRENT) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var u = CURRENT;
      // agrupa memória por dono
      var byOwner = {};
      getSheetsLocal().forEach(function (s) {
        var o = s._owner || u.code; (byOwner[o] = byOwner[o] || []).push(s);
      });
      var pmByOwner = {};
      var pm = getPmLocal();
      Object.keys(pm).forEach(function (fid) {
        var f = pm[fid]; var o = (f && f._owner) || u.code;
        (pmByOwner[o] = pmByOwner[o] || {})[fid] = f;
      });
      saveTargets(u).forEach(function (code) {
        writeOwnerDoc(code, byOwner[code] || [], pmByOwner[code] || {}, getLogosLocal())
          .then(function () { log('Salvo na nuvem:', code, '(' + (reason || 'auto') + ')'); })
          .catch(function (e) { warn('Erro ao salvar', code, e); });
      });
    }, 700);
  }

  /* ==========================================================================
     10) SOMENTE LEITURA na interface (trava a folha não editável)
     ========================================================================== */
  function applyRoLock(id) {
    try {
      var s = (typeof get === 'function') ? get(id)
            : getSheetsLocal().filter(function (x) { return x.id === id; })[0];
      var el = document.getElementById('c-' + id);
      if (!el) return;
      var ro = !!(s && s._ro);

      var prev = el.querySelector('.mtm-ro-banner'); if (prev) prev.remove();

      var nodes = el.querySelectorAll('input,textarea,select,button,[contenteditable="true"],[contenteditable=""]');
      Array.prototype.forEach.call(nodes, function (node) {
        if (node.closest && node.closest('.mtm-ro-banner')) return;
        if (ro) {
          if (node.hasAttribute('contenteditable') && node.getAttribute('contenteditable') !== 'false') {
            node.setAttribute('data-mtm-ce', '1');
            node.setAttribute('contenteditable', 'false');
          } else if ('disabled' in node && !node.disabled) {
            node.setAttribute('data-mtm-dis', '1');
            node.disabled = true;
          }
        } else {
          if (node.getAttribute('data-mtm-ce') === '1') { node.setAttribute('contenteditable', 'true'); node.removeAttribute('data-mtm-ce'); }
          if (node.getAttribute('data-mtm-dis') === '1') { node.disabled = false; node.removeAttribute('data-mtm-dis'); }
        }
      });

      if (ro) {
        var owner = (s && s._owner) ? (NAMES[s._owner] || s._owner) : 'outro usuário';
        var b = document.createElement('div');
        b.className = 'mtm-ro-banner';
        b.style.cssText = 'position:sticky;top:0;z-index:60;background:linear-gradient(90deg,#8b5cf6,#3b82f6);color:#fff;font:600 12px Inter,system-ui,sans-serif;padding:8px 12px;border-radius:8px;margin:0 0 10px;letter-spacing:.02em';
        b.textContent = '🔒 SOMENTE LEITURA — folha de ' + owner + '. Você pode visualizar, mas não editar nem salvar.';
        el.insertBefore(b, el.firstChild);
      }
    } catch (e) { /* nunca quebrar o render */ }
  }

  /* ==========================================================================
     11) TEMPO REAL (conservador): atualiza os dados DOS OUTROS sem apagar o
         que a pessoa está editando no próprio conjunto.
     ========================================================================== */
  function stopLive() { try { if (liveUnsub) liveUnsub(); } catch (e) {} liveUnsub = null; }

  function mergeRemoteKeepingOwn(u, docs) {
    if (applyingCloud) return;
    // mantém as folhas/projetos DA PRÓPRIA pessoa (em memória, com edições)
    var ownSheets = getSheetsLocal().filter(function (s) { return (s._owner || u.code) === u.code; });
    var ownPm = {}; var pm = getPmLocal();
    Object.keys(pm).forEach(function (fid) { if (((pm[fid] && pm[fid]._owner) || u.code) === u.code) ownPm[fid] = pm[fid]; });

    // reconstrói os OUTROS a partir do remoto
    var others = docs.filter(function (d) { return d.code !== u.code; });
    var builtOthers = buildFromDocs(u, others);

    var merged = {
      sheets: ownSheets.concat(builtOthers.sheets),
      pmData: Object.assign({}, ownPm, builtOthers.pmData),
      logos: Object.assign({}, getLogosLocal(), builtOthers.logos)
    };
    applyState(merged);
  }

  function startLive() {
    if (!cloudReady || !db || !CURRENT) return;
    stopLive();
    var u = CURRENT;
    var vis = visibleOwners(u);

    if (vis === '*' || vis === '*_except_owner') {
      liveUnsub = db.collection(USERS_COLLECTION).onSnapshot(function (snap) {
        var docs = [];
        snap.forEach(function (doc) {
          if (vis === '*_except_owner' && doc.id === OWNER_CODE) return;
          docs.push({ code: doc.id, data: doc.data() });
        });
        mergeRemoteKeepingOwn(u, docs);
      }, function (err) { warn('Listener falhou:', err); });
    } else if (u.role === 'apresentado') {
      // apenas o doc do sênior (leitura viva); o próprio a gente não sobrescreve
      liveUnsub = db.collection(USERS_COLLECTION).doc(SENIOR_CODE).onSnapshot(function (doc) {
        mergeRemoteKeepingOwn(u, [{ code: SENIOR_CODE, data: doc.exists ? doc.data() : {} }]);
      }, function (err) { warn('Listener sênior falhou:', err); });
    }
    // comum: sem listener (evita apagar edição não salva). Recarrega ao reabrir.
  }

  /* ==========================================================================
     12) PATCH das funções do app (liga o salvamento à nuvem + trava RO)
     ========================================================================== */
  function patchLocalFunctions() {
    var originalSaveSheets = (typeof saveSheets === 'function') ? saveSheets : null;
    var originalSalvarAgora = (typeof salvarAgora === 'function') ? salvarAgora : null;
    var originalPmSave = (typeof pmSave === 'function') ? pmSave : null;
    var originalSetActive = (typeof setActive === 'function') ? setActive : null;
    var originalRenderContent = (typeof renderContent === 'function') ? renderContent : null;

    window.saveSheets = function () {
      if (originalSaveSheets) originalSaveSheets();
      cloudSaveScoped('saveSheets');
    };
    window.salvarAgora = function () {
      if (originalSalvarAgora) originalSalvarAgora();
      cloudSaveScoped('salvarAgora');
    };
    window.pmSave = function () {
      if (originalPmSave) originalPmSave();
      cloudSaveScoped('pmSave');
    };
    if (originalSetActive) {
      window.setActive = function (id) { var r = originalSetActive.apply(this, arguments); applyRoLock(id); return r; };
    }
    if (originalRenderContent) {
      window.renderContent = function (id) { var r = originalRenderContent.apply(this, arguments); applyRoLock(id); return r; };
    }

    window.mtmForceCloudSave = function () {
      if (!cloudReady) { alert('Firestore ainda não está pronto.'); return; }
      cloudSaveScoped('manual');
    };

    log('Funções do app conectadas.');
  }

  /* ==========================================================================
     13) API DE LOGIN (chamada pela tela de código no index.html)
     ========================================================================== */
  function setCurrent(code) {
    var c = String(code || '').trim();
    CURRENT = { code: c, role: roleFor(c), name: NAMES[c] || c };
    try { sessionStorage.setItem('mtm_role', CURRENT.role); } catch (e) {}
    log('Usuário:', CURRENT.code, '· papel:', CURRENT.role);
    return CURRENT;
  }

  // Retorna { ok, role, name, welcome } e dispara o carregamento.
  window.MTM_LOGIN = function (code) {
    var c = String(code || '').trim();
    if (!c) return { ok: false, error: 'Digite o seu código de acesso.' };
    var u = setCurrent(c);
    // dispara load quando o Firestore estiver pronto (ou já está)
    readyPromise.then(function () { loadForUser(); });
    return {
      ok: true,
      role: u.role,
      name: u.name,
      welcome: (u.role === 'owner') ? OWNER_WELCOME : ''
    };
  };

  // Retoma sessão (após reload) sem mostrar boas-vindas.
  window.MTM_RESUME = function (code) {
    var c = String(code || '').trim();
    if (!c) return;
    setCurrent(c);
    readyPromise.then(function () { loadForUser(); });
  };

  window.MTM_LOGOUT = function () {
    stopLive();
    try { sessionStorage.removeItem('mtm_chapa_ok'); sessionStorage.removeItem('mtm_role'); } catch (e) {}
    // limpa os dados locais para não vazar para o próximo login neste navegador
    setSheetsInMemory([]); setPmInMemory({}); setLogosLocal({});
    CURRENT = null;
    location.reload();
  };

  window.MTM_CURRENT = function () { return CURRENT ? JSON.parse(JSON.stringify(CURRENT)) : null; };

  window.MTM_DIAG = function () {
    return {
      cloudReady: cloudReady,
      current: CURRENT,
      hasFirebaseSDK: (typeof firebase !== 'undefined'),
      config: (function () { var c = getFirebaseConfig(); return { projectId: c.projectId, apiKeyOk: !!(c.apiKey && c.apiKey !== 'COLE_AQUI') }; })(),
      sheetsInMemory: getSheetsLocal().length
    };
  };

  /* ==========================================================================
     14) INICIALIZAÇÃO DO FIREBASE
     ========================================================================== */
  function startFirebase() {
    if (typeof firebase === 'undefined') {
      warn('SDK do Firebase não carregou. Confira os <script> do firebasejs no index.html. Rodando offline.');
      readyResolve(); // libera o load em modo offline
      return;
    }
    var cfg = getFirebaseConfig();
    if (!cfg.apiKey || cfg.apiKey === 'COLE_AQUI') {
      warn('firebaseConfig sem apiKey. Preencha window.FIREBASE_CONFIG no index.html. Rodando offline.');
      readyResolve();
      return;
    }

    try {
      if (!firebase.apps.length) firebase.initializeApp(cfg);
      db = firebase.firestore();
    } catch (e) {
      warn('Falha ao iniciar Firestore:', e);
      readyResolve();
      return;
    }

    // Auth anônimo (necessário para as regras padrão). Não trava se falhar.
    var authP = Promise.resolve();
    try {
      if (firebase.auth) {
        authP = firebase.auth().signInAnonymously()
          .then(function () { log('Auth anônimo OK.'); })
          .catch(function (e) { warn('Auth anônimo falhou (ative Anonymous em Authentication, ou ajuste as regras):', e); });
      }
    } catch (e) {}

    authP.then(function () {
      cloudReady = true;
      log('Firestore pronto.');
      readyResolve(); // agora qualquer login/resume pendente carrega
    });
  }

  /* ==========================================================================
     15) BOOTSTRAP
     ========================================================================== */
  document.addEventListener('DOMContentLoaded', function () {
    patchLocalFunctions();
    try { startFirebase(); }
    catch (err) { warn('Erro crítico ao iniciar Firebase:', err); readyResolve(); }

    // Retomada defensiva: útil quando o index.html já tinha ocultado a portaria
    // mas não chamou MTM_RESUME após uma atualização da página.
    try {
      var savedCode = sessionStorage.getItem('mtm_chapa_ok');
      if (savedCode && !CURRENT) window.MTM_RESUME(savedCode);
    } catch (e) {}
  });

  log('firebase-mtm.js (papéis) carregado.');
})();
