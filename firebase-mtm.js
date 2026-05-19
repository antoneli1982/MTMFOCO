/* ================================================================
   firebase-mtm.js  —  MTM EM FOCO
   Domínio: mtmemfoco.unismartsolution.com.br
   Firebase REST API — funciona em qualquer domínio HTTPS
   ================================================================ */
(function () {
  'use strict';

  var API_KEY = 'AIzaSyD3cOYgBvVbX8VHeYSe7iLY9c2ozKFtJZY';
  var PROJECT = 'mtm-em-foco';
  var DB_URL  = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';

  var SESSION_KEY = 'fbmtm_session';
  var SYNC_KEYS   = ['mtm_sheets','pmgr_v3','mtm_client_logos_v1'];
  var session     = null;
  var syncPending = {}, syncTimer = null, isOnline = navigator.onLine;

  /* ── REST HELPERS ── */
  async function authPost(endpoint, body) {
    var r = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:' + endpoint + '?key=' + API_KEY, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
    });
    var d = await r.json();
    if (!r.ok) throw { code: (d.error && d.error.message) || 'UNKNOWN' };
    return d;
  }

  async function fsSet(uid, key, value) {
    if (!session) return;
    await fetch(DB_URL + '/users/' + uid + '/data/' + key, {
      method:'PATCH',
      headers:{'Content-Type':'application/json','Authorization':'Bearer ' + session.idToken},
      body: JSON.stringify({ fields:{ value:{stringValue:value}, ts:{stringValue:new Date().toISOString()} } })
    });
  }

  async function fsGet(uid, key) {
    if (!session) return null;
    var r = await fetch(DB_URL + '/users/' + uid + '/data/' + key, {
      headers:{'Authorization':'Bearer ' + session.idToken}
    });
    if (!r.ok) return null;
    var d = await r.json();
    return (d.fields && d.fields.value && d.fields.value.stringValue) || null;
  }

  async function refreshToken() {
    if (!session || !session.refreshToken) return false;
    try {
      var r = await fetch('https://securetoken.googleapis.com/v1/token?key=' + API_KEY, {
        method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:'grant_type=refresh_token&refresh_token=' + session.refreshToken
      });
      var d = await r.json();
      if (d.id_token) { session.idToken = d.id_token; session.refreshToken = d.refresh_token; saveSession(); return true; }
    } catch(e) {}
    return false;
  }

  function saveSession()  { try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch(e){} }
  function loadSession()  { try { var s=localStorage.getItem(SESSION_KEY); return s?JSON.parse(s):null; } catch(e){ return null; } }
  function clearSession() { session=null; try { localStorage.removeItem(SESSION_KEY); } catch(e){} }

  /* ── ESTILOS ── */
  var SI  = 'width:100%;padding:12px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:#111827;color:#f0f4ff;font-size:14px;margin-bottom:14px;outline:none;font-family:Inter,sans-serif;box-sizing:border-box;';
  var SIP = 'width:100%;padding:12px 44px 12px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.12);background:#111827;color:#f0f4ff;font-size:14px;outline:none;font-family:Inter,sans-serif;box-sizing:border-box;';

  function fPass(id, ph) {
    return '<div style="position:relative;margin-bottom:14px;">'
      + '<input id="'+id+'" type="password" placeholder="'+ph+'" style="'+SIP+'">'
      + '<button type="button" onclick="fbmtmEye(\''+id+'\')" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;font-size:18px;color:#7a8aaa;padding:2px;">👁</button>'
      + '</div>';
  }
  function lbl(t) { return '<label style="color:#7a8aaa;font-size:11px;font-weight:600;letter-spacing:.5px;display:block;margin-bottom:5px;">'+t+'</label>'; }

  /* ── UI ── */
  function buildLoginUI() {
    if (document.getElementById('fbmtm-overlay')) return;
    var ov = document.createElement('div');
    ov.id = 'fbmtm-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,8,15,.97);display:flex;align-items:center;justify-content:center;font-family:Inter,sans-serif;backdrop-filter:blur(20px);';
    ov.innerHTML = `
      <div style="background:#0d1525;border:1px solid rgba(0,212,255,.18);border-radius:20px;padding:40px 44px;width:420px;max-width:96vw;box-shadow:0 32px 80px rgba(0,0,0,.95);">

        <div style="text-align:center;margin-bottom:32px">
          <div style="font-size:26px;font-weight:800;letter-spacing:1.5px;background:linear-gradient(135deg,#00d4ff,#4f8ef7,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">MTM EM FOCO</div>
          <div style="color:#7a8aaa;font-size:12px;margin-top:6px">☁️ Sincronização em Nuvem</div>
        </div>

        <div style="display:flex;gap:6px;margin-bottom:28px;">
          <button id="fbmtm-tab-l" onclick="fbmtmShowTab('login')"  style="flex:1;padding:10px;border-radius:9px;border:1px solid rgba(0,212,255,.35);background:rgba(0,212,255,.1);color:#00d4ff;font-weight:700;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;">Entrar</button>
          <button id="fbmtm-tab-s" onclick="fbmtmShowTab('signup')" style="flex:1;padding:10px;border-radius:9px;border:1px solid rgba(255,255,255,.08);background:transparent;color:#7a8aaa;font-weight:600;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;">Criar Conta</button>
        </div>

        <!-- ENTRAR -->
        <div id="fbmtm-fl">
          ${lbl('E-MAIL')}
          <input id="fbmtm-el" type="email" placeholder="seu@email.com" style="${SI}">
          ${lbl('SENHA')}
          ${fPass('fbmtm-pl','••••••••')}
          <button onclick="fbmtmLogin()" style="width:100%;padding:14px;border-radius:9px;border:none;background:linear-gradient(135deg,#00d4ff,#4f8ef7,#7c3aed);color:#fff;font-weight:700;font-size:14px;cursor:pointer;font-family:Inter,sans-serif;">Entrar</button>
          <div onclick="fbmtmReset()" style="text-align:center;margin-top:13px;color:#4f8ef7;font-size:12px;cursor:pointer;text-decoration:underline;">Esqueci minha senha</div>
        </div>

        <!-- CRIAR CONTA -->
        <div id="fbmtm-fs" style="display:none">
          ${lbl('NOME COMPLETO')}
          <input id="fbmtm-ns" type="text" placeholder="Ivan Carlos Antoneli" style="${SI}">
          ${lbl('E-MAIL')}
          <input id="fbmtm-es" type="email" placeholder="seu@email.com" style="${SI}">
          ${lbl('SENHA')}
          ${fPass('fbmtm-ps','•••• (mín. 4 dígitos)')}
          <button onclick="fbmtmSignup()" style="width:100%;padding:14px;border-radius:9px;border:none;background:linear-gradient(135deg,#00e5a0,#00b87a);color:#001a12;font-weight:700;font-size:14px;cursor:pointer;font-family:Inter,sans-serif;">Criar Conta e Entrar</button>
        </div>

        <div id="fbmtm-msg" style="margin-top:16px;text-align:center;font-size:13px;color:#ff4d6d;min-height:20px;font-family:Inter,sans-serif;font-weight:500;"></div>

        <hr style="border:none;border-top:1px solid rgba(255,255,255,.06);margin:24px 0">
        <div style="text-align:center">
          <button onclick="fbmtmSkipLogin()" style="background:transparent;border:1px solid rgba(255,255,255,.1);color:#7a8aaa;padding:9px 24px;border-radius:9px;font-size:12px;cursor:pointer;font-family:Inter,sans-serif;">Usar sem conta (somente local)</button>
        </div>
      </div>
    `;
    document.body.appendChild(ov);
    ov.addEventListener('keydown', function(e){
      if (e.key!=='Enter') return;
      var fs=document.getElementById('fbmtm-fs');
      if (fs&&fs.style.display!=='none') fbmtmSignup(); else fbmtmLogin();
    });
  }

  /* ── ABAS ── */
  window.fbmtmShowTab = function(tab) {
    var fl=document.getElementById('fbmtm-fl'),fs=document.getElementById('fbmtm-fs');
    var tl=document.getElementById('fbmtm-tab-l'),ts=document.getElementById('fbmtm-tab-s');
    if(!fl) return;
    fl.style.display=tab==='login'?'':'none';
    fs.style.display=tab==='signup'?'':'none';
    var A='flex:1;padding:10px;border-radius:9px;font-size:13px;cursor:pointer;font-family:Inter,sans-serif;border:1px solid ';
    tl.style.cssText=A+(tab==='login'?'rgba(0,212,255,.35);background:rgba(0,212,255,.1);color:#00d4ff;font-weight:700;':'rgba(255,255,255,.08);background:transparent;color:#7a8aaa;font-weight:600;');
    ts.style.cssText=A+(tab==='signup'?'rgba(0,229,160,.35);background:rgba(0,229,160,.1);color:#00e5a0;font-weight:700;':'rgba(255,255,255,.08);background:transparent;color:#7a8aaa;font-weight:600;');
    setMsg('');
  };

  window.fbmtmEye = function(id) { var e=document.getElementById(id); if(e) e.type=e.type==='password'?'text':'password'; };

  /* ── LOGIN ── */
  window.fbmtmLogin = async function() {
    var email=g('fbmtm-el'), pass=g('fbmtm-pl');
    if(!email||!pass){ setMsg('Preencha e-mail e senha.'); return; }
    setMsg('Entrando...','#4f8ef7');
    try { var d=await authPost('signInWithPassword',{email,password:pass,returnSecureToken:true}); onLogged(d); }
    catch(e){ setMsg(ferr(e.code)); }
  };

  /* ── CADASTRO → ENTRA DIRETO ── */
  window.fbmtmSignup = async function() {
    var nome=g('fbmtm-ns'), email=g('fbmtm-es'), pass=g('fbmtm-ps');
    if(!nome)          { setMsg('Digite seu nome.'); return; }
    if(!email)         { setMsg('Digite seu e-mail.'); return; }
    if(!pass)          { setMsg('Digite uma senha.'); return; }
    if(pass.length<4)  { setMsg('Senha deve ter no mínimo 4 dígitos.'); return; }
    setMsg('Criando conta...','#00e5a0');
    try {
      var d = await authPost('signUp',{email,password:pass,returnSecureToken:true});
      await fetch('https://identitytoolkit.googleapis.com/v1/accounts:update?key='+API_KEY,{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({idToken:d.idToken,displayName:nome,returnSecureToken:true})
      });
      d.displayName = nome;
      onLogged(d);
    } catch(e){ setMsg(ferr(e.code)); }
  };

  /* ── RESET SENHA ── */
  window.fbmtmReset = async function() {
    var email=g('fbmtm-el');
    if(!email){ setMsg('Digite seu e-mail primeiro.'); return; }
    try { await authPost('sendOobCode',{requestType:'PASSWORD_RESET',email}); setMsg('✅ E-mail enviado!','#00e5a0'); }
    catch(e){ setMsg(ferr(e.code)); }
  };

  window.fbmtmSkipLogin = function() { closeOverlay(); showToastFB('ℹ️ Modo local ativado',false,4000); };

  window.fbmtmOpenUserMenu = function() {
    if(!session){ buildLoginUI(); return; }
    if(confirm('👤 '+(session.displayName||session.email)+'\n'+session.email+'\n\nDeseja sair?')){ clearSession(); updateStatusBar(); buildLoginUI(); }
  };

  function onLogged(d) {
    session = { idToken:d.idToken, refreshToken:d.refreshToken, uid:d.localId, email:d.email, displayName:d.displayName||d.email.split('@')[0] };
    saveSession(); closeOverlay(); updateStatusBar();
    showToastFB('👋 Bem-vindo, '+session.displayName+'!',false,3000);
    loadUserData();
  }

  function closeOverlay(){ var e=document.getElementById('fbmtm-overlay'); if(e) e.remove(); }
  function g(id){ var e=document.getElementById(id); return e?e.value.trim():''; }
  function setMsg(t,c){ var e=document.getElementById('fbmtm-msg'); if(e){e.textContent=t;e.style.color=c||'#ff4d6d';} }
  function ferr(code){
    return({'EMAIL_NOT_FOUND':'❌ E-mail não cadastrado.','INVALID_PASSWORD':'❌ Senha incorreta.',
    'INVALID_LOGIN_CREDENTIALS':'❌ E-mail ou senha incorretos.','EMAIL_EXISTS':'❌ E-mail já cadastrado. Clique em Entrar.',
    'INVALID_EMAIL':'❌ E-mail inválido.','WEAK_PASSWORD':'❌ Senha muito fraca (mín. 4 dígitos).',
    'TOO_MANY_ATTEMPTS_TRY_LATER':'⏳ Muitas tentativas. Aguarde.','USER_DISABLED':'❌ Conta desativada.'}[code]||'❌ '+code);
  }

  /* ── STATUS BAR ── */
  function buildStatusBar(){
    if(document.getElementById('fbmtm-status')) return;
    var bar=document.createElement('div');
    bar.id='fbmtm-status'; bar.onclick=function(){ window.fbmtmOpenUserMenu(); }; bar.title='Clique para sair';
    bar.style.cssText='position:fixed;bottom:12px;right:14px;z-index:9998;display:flex;align-items:center;gap:8px;background:rgba(13,21,37,.94);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:6px 14px;font-family:Inter,sans-serif;font-size:11px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.5);backdrop-filter:blur(8px);user-select:none;';
    document.body.appendChild(bar); updateStatusBar();
  }

  function updateStatusBar(){
    var bar=document.getElementById('fbmtm-status'); if(!bar) return;
    if(session){ var n=session.displayName||session.email.split('@')[0]; bar.innerHTML='<span style="width:8px;height:8px;border-radius:50%;background:#00e5a0;display:inline-block;flex-shrink:0"></span><span style="color:#f0f4ff;font-weight:600;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+n.replace(/</g,'&lt;')+'</span><span style="color:#4f8ef7;">☁️</span>'; }
    else { bar.innerHTML='<span style="width:8px;height:8px;border-radius:50%;background:#ff9500;display:inline-block;flex-shrink:0"></span><span style="color:#7a8aaa;">Sem login</span>'; }
  }

  /* ── SYNC ── */
  function scheduleSyncKey(key,value){ if(!session) return; syncPending[key]=value; clearTimeout(syncTimer); syncTimer=setTimeout(flushSync,2000); }

  async function flushSync(){
    if(!session||!isOnline) return;
    var keys=Object.keys(syncPending); if(!keys.length) return;
    var copy=Object.assign({},syncPending); syncPending={};
    for(var i=0;i<keys.length;i++){ try{ await fsSet(session.uid,keys[i],copy[keys[i]]); }catch(e){} }
    showToastFB('☁️ Salvo na nuvem',false,1800);
  }

  async function loadUserData(){
    if(!session) return;
    var hasData=false;
    for(var i=0;i<SYNC_KEYS.length;i++){
      var key=SYNC_KEYS[i];
      try{
        var val=await fsGet(session.uid,key);
        if(val){ _origSetItem.call(localStorage,key,val); hasData=true; }
      }catch(e){
        var ok=await refreshToken();
        if(ok){ try{ var v2=await fsGet(session.uid,key); if(v2){ _origSetItem.call(localStorage,key,v2); hasData=true; } }catch(e2){} }
      }
    }
    if(hasData){ showToastFB('✅ Dados carregados!',false,2500); reloadAppData(); }
    else{ SYNC_KEYS.forEach(function(k){ var l=_origGetItem.call(localStorage,k); if(l) scheduleSyncKey(k,l); }); }
  }

  function reloadAppData(){
    try{ if(typeof loadSheets==='function') loadSheets(); if(typeof pmLoad==='function') pmLoad(); if(typeof renderTabs==='function') renderTabs(); }
    catch(e){ setTimeout(function(){ location.reload(); },500); }
  }

  var _origSetItem=localStorage.setItem.bind(localStorage);
  var _origGetItem=localStorage.getItem.bind(localStorage);
  localStorage.setItem=function(key,value){ _origSetItem(key,value); if(SYNC_KEYS.indexOf(key)!==-1) scheduleSyncKey(key,value); };

  function showToastFB(msg,isError,dur){
    if(typeof showToast==='function'){ showToast(msg,isError); return; }
    var t=document.createElement('div'); t.textContent=msg;
    t.style.cssText='position:fixed;bottom:52px;right:14px;z-index:99997;background:'+(isError?'#2a0a10':'#0a1422')+';border:1px solid '+(isError?'#ff4d6d':'#00d4ff')+';color:'+(isError?'#ff4d6d':'#f0f4ff')+';padding:9px 16px;border-radius:9px;font-size:12px;font-family:Inter,sans-serif;';
    document.body.appendChild(t);
    setTimeout(function(){ t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(function(){ t.remove(); },300); },dur||3500);
  }

  window.addEventListener('online',  function(){ isOnline=true;  showToastFB('🌐 Conexão restaurada!',false,3000); if(Object.keys(syncPending).length) flushSync(); });
  window.addEventListener('offline', function(){ isOnline=false; showToastFB('📴 Sem conexão',true,4000); });

  /* ── START ── */
  function init(){
    buildStatusBar();
    var saved=loadSession();
    if(saved&&saved.idToken){ session=saved; updateStatusBar(); loadUserData(); refreshToken(); }
    else{ buildLoginUI(); }
  }

  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded',init); } else { init(); }
})();
