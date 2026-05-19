/* ================================================================
   firebase-mtm.js — MTM EM FOCO
   Carrega projeto automaticamente em qualquer computador
   ================================================================ */
(function () {
  'use strict';

  /* ── DADOS DO PROJETO EMBUTIDOS ── */
  var PROJETO_JSON = {"format":"MTM_FILE","version":1,"app":"Folha de Processo MTM","author":"Engº Ivan Carlos Antoneli","createdAt":"2026-05-19T15:08:58.243Z","modo":"individual","empresa":"SESÉ","projeto":"VVT 109088","sheetsCount":1,"sheets":[{"id":"sh8_1779128276877","label":"PROCESSO DEPÓSITO","header":{"empresa":"SESÉ","projeto":"VVT 109088","allowPersonal":6.42,"allowFatigue":7.21,"allowContingency":3.12},"book":"<h2>📝 PROCESSO DEPÓSITO — Livro de Informações</h2><p style=\"color:var(--text2)\">Use este espaço para registrar <b>tudo o que for relevante</b> sobre o processo:</p><ul><li>Premissas e condições de contorno</li><li>Layout do posto, equipamentos e ferramentas</li><li>Riscos ergonômicos e ações tomadas</li><li>Hipóteses validadas e descartadas</li><li>Decisões tomadas, responsáveis e datas</li><li>Pendências e próximos passos</li></ul><p><i>Esta caixa de texto suporta formatação, listas, links, tabelas e mais. Use a barra de ferramentas acima.</i></p>","fadiga":{"tipo":"","secao":"","operacao":"1010","descLinha":"","data":"2026-05-18","elaborado":"","verificado":"","tvPausa":3.75,"tvLimpPesMin":15,"tvLimpPesBase":"dia","tvLimpPosMin":30,"tvLimpPosBase":"dia","tvLimpGerMin":0,"tvLimpGerBase":"semana","tvTrocaMin":0,"tvTrocaPcs":0,"tvTrocaProdH":0,"tvCadernoMin":0,"tvCadernoBase":"dia","tvTempMin":0,"tvTempBase":"dia","tvManParMin":0,"tvManParBase":"dia","tvManFuncMin":0,"tvManFuncBase":"dia","tvInterrMin":0,"tvInterrBase":"dia","tvRevFreq":0,"tvRevPassos":0,"tvRevTmu":0,"tvGinPrepMin":0,"tvGinPrepBase":"turno","tvGinCompMin":0,"tvGinCompBase":"turno","tvReuProdMin":32,"tvReuProdBase":"dia","tvReuQSMin":6.4,"tvReuQSBase":"dia","terFisico":0.054,"terMental":0.018,"terRecup":0.71,"terMonot":0.021,"terTermica":0,"terAtmosf":0,"terRuido":0,"terUmid":0,"terVibr":0},"rows":[{"id":"r_sh8_1779128276877_1779128276961_3530","desc":"Caminhar até a estante e voltar (2 m ida + 2 m volta = 4 m total)","agrega":"Não","code":"KA","tmu":25,"q":"3","f":"2","ttmu":150,"tsec":5.4},{"id":"r_sh8_1779128276877_1779128276962_7572","desc":"Abaixar-se para alcançar a caixa na prateleira inferior","agrega":"Não","code":"KB","tmu":60,"q":"1","f":"1","ttmu":60,"tsec":2.16},{"id":"r_sh8_1779128276877_1779128276962_9334","desc":"Apanhar caixa de 9 kg (volumosa, fácil, aproximado) e colocar no carrinho — faixa 1 remanescente (Regra E2)","agrega":"Sim","code":"AL2","tmu":80,"q":"1","f":"1","ttmu":80,"tsec":2.88},{"id":"r_sh8_1779128276877_1779128276963_6696","desc":"Retirar divisória de papelão (50×40 cm — volumosa, Regra A3 sobe classe de peso) e colocar de lado (faixa 2)","agrega":"Sim","code":"AH2","tmu":45,"q":"1","f":"1","ttmu":45,"tsec":1.62},{"id":"r_sh8_1779128276877_1779128276963_2313","desc":"Afastar plástico para cada lado da caixa expondo as peças (≤1 daN, fácil, aproximado, faixa 2)","agrega":"Sim","code":"AA2","tmu":35,"q":"1","f":"1","ttmu":35,"tsec":1.26},{"id":"r_sh8_1779128276877_1779128276964_6271","desc":"","agrega":"","code":"","tmu":"","q":"","f":"","ttmu":0,"tsec":0},{"id":"r_sh8_1779128276877_1779128276964_7330","desc":"","agrega":"","code":"","tmu":"","q":"","f":"","ttmu":0,"tsec":0},{"id":"r_sh8_1779128276877_1779128276965_5038","desc":"","agrega":"","code":"","tmu":"","q":"","f":"","ttmu":0,"tsec":0},{"id":"r_sh8_1779128276877_1779128276965_8765","desc":"","agrega":"","code":"","tmu":"","q":"","f":"","ttmu":0,"tsec":0}]}],"projectManager":{"f_1778874493225_43wmu":{"id":"f_1778874493225_43wmu","name":"SESÉ","logo":null,"projects":[{"id":"p_1779128276870_833sp","client":"SESÉ","name":"VVT 109088","logo":null,"date":"18/05/2026","sheets":["sh8_1779128276877"],"notes":[]}]}}};

  /* ── CHAVE DE CONTROLE ── */
  var LOADED_KEY = 'fbmtm_projeto_loaded_sh8_1779128276877';

  function carregarProjeto() {
    /* Só carrega se ainda não foi carregado neste navegador */
    var jaCarregado = localStorage.getItem(LOADED_KEY);

    /* Verifica se já existe folha com mesmo ID no localStorage */
    var sheetsRaw = localStorage.getItem('mtm_sheets');
    var jaTemFolha = false;
    if (sheetsRaw) {
      try {
        var arr = JSON.parse(sheetsRaw);
        jaTemFolha = Array.isArray(arr) && arr.some(function(s){ return s.id === 'sh8_1779128276877'; });
      } catch(e) {}
    }

    if (jaTemFolha) {
      console.log('[MTM] ✅ Projeto já carregado.');
      return;
    }

    /* Injetar folhas no localStorage */
    try {
      var existentes = [];
      if (sheetsRaw) { try { existentes = JSON.parse(sheetsRaw) || []; } catch(e){ existentes = []; } }
      var novas = PROJETO_JSON.sheets;
      /* Mescla: adiciona só as folhas que não existem */
      novas.forEach(function(nova){
        if (!existentes.some(function(e){ return e.id === nova.id; })) {
          existentes.push(nova);
        }
      });
      localStorage.setItem('mtm_sheets', JSON.stringify(existentes));

      /* Injetar Gerenciador de Projetos */
      if (PROJETO_JSON.projectManager) {
        var pmRaw = localStorage.getItem('pmgr_v3');
        var pm = {};
        if (pmRaw) { try { pm = JSON.parse(pmRaw) || {}; } catch(e){ pm = {}; } }
        Object.keys(PROJETO_JSON.projectManager).forEach(function(fid){
          if (!pm[fid]) pm[fid] = PROJETO_JSON.projectManager[fid];
        });
        localStorage.setItem('pmgr_v3', JSON.stringify(pm));
      }

      /* Injetar logos */
      if (PROJETO_JSON.clientLogos) {
        var logosRaw = localStorage.getItem('mtm_client_logos_v1');
        var logos = {};
        if (logosRaw) { try { logos = JSON.parse(logosRaw) || {}; } catch(e){ logos = {}; } }
        Object.keys(PROJETO_JSON.clientLogos).forEach(function(k){
          if (!logos[k]) logos[k] = PROJETO_JSON.clientLogos[k];
        });
        localStorage.setItem('mtm_client_logos_v1', JSON.stringify(logos));
      }

      localStorage.setItem(LOADED_KEY, '1');
      console.log('[MTM] ✅ Projeto SESÉ / VVT 109088 carregado automaticamente!');

      /* Recarregar a interface após injetar */
      setTimeout(function(){
        try {
          if (typeof loadSheets  === 'function') loadSheets();
          if (typeof pmLoad      === 'function') pmLoad();
          if (typeof renderTabs  === 'function') renderTabs();
          if (typeof setActive   === 'function') setActive('sh8_1779128276877');
        } catch(e) {
          location.reload();
        }
      }, 300);

    } catch(e) {
      console.error('[MTM] Erro ao carregar projeto:', e);
    }
  }

  /* ── INICIAR APÓS O APP CARREGAR ── */
  function init() {
    /* Aguarda o app principal inicializar antes de injetar */
    setTimeout(carregarProjeto, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
