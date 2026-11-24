/* MTM em Foco — Análise por vídeo (offline) · v4 */
(() => {
'use strict';
/* Núcleo de leitura de movimento — sem dependência de navegador (testável em Node) */
function mvCore(){
  'use strict';
  const R = 4;            // busca de deslocamento da câmera (px na imagem reduzida)
  const NOISE = 14;       // diferença mínima de cinza considerada movimento

  // Estima deslocamento global (câmera) entre dois quadros e devolve energia residual
  function frameMotion(prev, cur, w, h){
    let best = Infinity, bdx = 0, bdy = 0;
    for(let dy=-R; dy<=R; dy++) for(let dx=-R; dx<=R; dx++){
      let s = 0, n = 0;
      for(let y=R; y<h-R; y+=2){
        const yo = (y+dy)*w, yc = y*w;
        for(let x=R; x<w-R; x+=2){ s += Math.abs(cur[yc+x] - prev[yo+x+dx]); n++; }
      }
      s /= n;
      if(s < best){ best = s; bdx = dx; bdy = dy; }
    }
    // residual após compensação, por zona 3x3, e centroide do movimento
    const zones = new Array(9).fill(0), zc = new Array(9).fill(0);
    let energy = 0, cnt = 0, cx = 0, cy = 0, mw = 0;
    for(let y=R; y<h-R; y++){
      const zy = Math.min(2, Math.floor(3*y/h));
      for(let x=R; x<w-R; x++){
        const zx = Math.min(2, Math.floor(3*x/w)), z = zy*3+zx;
        let d = Math.abs(cur[y*w+x] - prev[(y+bdy)*w+x+bdx]);
        d = d > NOISE ? d - NOISE : 0;
        energy += d; cnt++; zones[z] += d; zc[z]++;
        if(d){ cx += x*d; cy += y*d; mw += d; }
      }
    }
    for(let i=0;i<9;i++) zones[i] = zc[i] ? zones[i]/zc[i] : 0;
    return { energy: energy/cnt, cam: Math.hypot(bdx,bdy), zones,
             cx: mw ? cx/mw/w : 0.5, cy: mw ? cy/mw/h : 0.5 };
  }

  function smooth(arr, half){
    return arr.map((_,i)=>{ let s=0,n=0; for(let j=Math.max(0,i-half); j<=Math.min(arr.length-1,i+half); j++){s+=arr[j];n++;} return s/n; });
  }
  function quantile(arr, q){ const a=[...arr].sort((x,y)=>x-y); return a.length? a[Math.min(a.length-1,Math.floor(q*(a.length-1)))] : 0; }

  /* samples: [{t, energy, cam, zones, cx, cy}] (o primeiro sem movimento) */
  function analyze(samples, duration, opts){
    opts = Object.assign({minSeg:0.8, maxSeg:6}, opts||{});
    // Reamostra numa grade uniforme de 0,2 s e normaliza pelo intervalo real entre quadros,
    // para que a leitura não dependa de quais quadros o navegador entregou.
    if(samples.length >= 4){
      const step = 0.2, src = samples.slice(1).map((s,i)=>Object.assign({}, s, {gap: Math.max(0.02, s.t - samples[i].t)}));
      const grid = []; let j = 0;
      for(let t = step/2; t < duration; t += step){
        while(j < src.length-1 && src[j+1].t < t) j++;
        const a = src[j], b = src[Math.min(src.length-1, j+1)];
        const w = (b.t === a.t) ? 0 : Math.min(1, Math.max(0, (t - a.t)/(b.t - a.t)));
        const mix = (x,y)=>x*(1-w)+y*w, k = s => step / s.gap;
        grid.push({ t, energy: mix(a.energy*k(a), b.energy*k(b)), cam: mix(a.cam,b.cam), cx: mix(a.cx,b.cx), cy: mix(a.cy,b.cy),
                    zones: a.zones.map((z,i)=>mix(z*k(a), b.zones[i]*k(b))) });
      }
      samples = grid;
    }
    const n = samples.length;
    if(n < 4) return {segments:[{start:0,end:duration,kind:'movimento'}], cycles:[], period:null, confidence:0, signal:[]};
    const dt = duration / n;
    const raw = samples.map(s=>s.energy);
    const sig = smooth(raw, Math.max(1, Math.round(0.25/dt)));
    const hi = quantile(sig, 0.9) || 1e-9, lo = quantile(sig, 0.1);
    const pauseLevel = lo + 0.12*(hi-lo);
    const camHigh = samples.map(s=>s.cam >= 3);

    // 1) cortes em vales do sinal (desaceleração entre movimentos)
    const minGap = Math.max(1, Math.round(opts.minSeg/dt));
    let cuts = [];
    for(let i=1;i<n-1;i++){
      if(sig[i] <= sig[i-1] && sig[i] < sig[i+1]){
        // profundidade do vale relativa aos picos vizinhos (janela ±1,5 s)
        const w = Math.round(1.5/dt);
        let lp=0, rp=0;
        for(let j=Math.max(0,i-w); j<i; j++) lp=Math.max(lp,sig[j]);
        for(let j=i+1; j<=Math.min(n-1,i+w); j++) rp=Math.max(rp,sig[j]);
        const depth = Math.min(lp,rp) - sig[i];
        if(depth > 0.18*(hi-lo)) cuts.push({i, depth});
      }
    }
    // mantém os vales mais profundos respeitando a duração mínima
    cuts.sort((a,b)=>b.depth-a.depth);
    const kept = [];
    for(const c of cuts){ if(kept.every(k=>Math.abs(k-c.i)>=minGap)) kept.push(c.i); }
    kept.sort((a,b)=>a-b);
    // divide trechos longos demais no ponto de menor sinal
    let bounds = [0, ...kept, n];
    let changed = true;
    while(changed){
      changed = false;
      for(let k=0;k<bounds.length-1;k++){
        const a=bounds[k], b=bounds[k+1];
        if((b-a)*dt > opts.maxSeg && b-a > 2*minGap){
          let m=a+minGap, mv=Infinity;
          for(let j=a+minGap;j<=b-minGap;j++) if(sig[j]<mv){mv=sig[j];m=j;}
          bounds.splice(k+1,0,m); changed=true; break;
        }
      }
    }
    const segments = [];
    for(let k=0;k<bounds.length-1;k++){
      const a=bounds[k], b=bounds[k+1];
      const sub = samples.slice(a,b), ss = sig.slice(a,b);
      const mean = ss.reduce((x,y)=>x+y,0)/Math.max(1,ss.length);
      const camShare = camHigh.slice(a,b).filter(Boolean).length/Math.max(1,b-a);
      const zones = new Array(9).fill(0); let cx=0, cy=0;
      sub.forEach(s=>{ s.zones.forEach((z,i)=>zones[i]+=z/sub.length); cx+=s.cx/sub.length; cy+=s.cy/sub.length; });
      segments.push({
        start: k===0 ? 0 : round2(samples[a].t),
        end: k===bounds.length-2 ? round2(duration) : round2(samples[b].t),
        kind: mean < pauseLevel ? 'pausa' : 'movimento',
        intensity: round2(mean/(hi||1)), camera: round2(camShare),
        features: zones.map(round4).concat([round4(cx), round4(cy)])
      });
    }
    // une pausas consecutivas
    for(let k=segments.length-1;k>0;k--){
      if(segments[k].kind==='pausa' && segments[k-1].kind==='pausa'){ segments[k-1].end=segments[k].end; segments.splice(k,1); }
    }

    // 2) periodicidade (autocorrelação) para sugerir ciclos
    const m = sig.reduce((a,b)=>a+b,0)/n, c = sig.map(v=>v-m);
    const v0 = c.reduce((a,b)=>a+b*b,0) || 1e-9;
    let period=null, conf=0;
    const minLag = Math.round(2/dt), maxLag = Math.floor(n/2);
    const ac = [];
    for(let L=minLag; L<=maxLag; L++){ let s=0; for(let i=0;i+L<n;i++) s+=c[i]*c[i+L]; ac.push({L, r:s/v0*(n/(n-L))}); }
    for(let k=1;k<ac.length-1;k++){
      if(ac[k].r>ac[k-1].r && ac[k].r>=ac[k+1].r && ac[k].r>conf){ conf=ac[k].r; period=ac[k].L*dt; }
    }
    const cycles = [];
    if(period && conf >= 0.35){
      // fronteiras de ciclo nos cortes mais próximos de múltiplos do período
      const cutTimes = segments.map(s=>s.start).concat([duration]);
      let t = cutTimes[1] !== undefined ? cutTimes[0] : 0;
      while(t + period*0.7 < duration){
        const target = t + period;
        let best = null;
        for(const ct of cutTimes){ if(ct > t + period*0.6 && Math.abs(ct-target) <= period*0.35 && (best===null || Math.abs(ct-target)<Math.abs(best-target))) best=ct; }
        if(best===null) break;
        cycles.push({start:round2(t), end:round2(best)});
        t = best;
      }
    } else { period = null; }
    return { segments, cycles, period: period? round2(period):null, confidence: round2(conf),
             signal: sig.map(v=>round4(v/(hi||1))), dt };
  }
  function round2(v){ return Math.round(v*100)/100; }
  function round4(v){ return Math.round(v*1e4)/1e4; }

  // Fração "6/420" ou decimal "0,5" → número
  function num(v, fb){
    if(v==null || v==='') return fb;
    const s = String(v).trim().replace(',', '.');
    if(/^[-+]?\d*\.?\d+\s*\/\s*\d*\.?\d+$/.test(s)){ const [a,b]=s.split('/').map(Number); return b? a/b : fb; }
    const x = Number(s); return Number.isFinite(x) ? x : fb;
  }
  function featDist(a,b){ let s=0; for(let i=0;i<Math.min(a.length,b.length);i++) s+=(a[i]-b[i])**2; return Math.sqrt(s); }

  return { frameMotion, analyze, num, featDist, smooth };
}

/* ── Interpretação da descrição da operação (offline, por regras) ── */
const PROMPT_EXAMPLE = 'Ex.: Tampar caixas plásticas no pallet. Andar 2 m até a pilha e pegar um lote de 5 tampas. Voltar ao pallet e apoiar o lote sobre as caixas. Colocar a tampa na caixa e pressionar as bordas para encaixar. Trocar o pallet a cada 36 caixas.';
const noAcc = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function stem(w) { w = noAcc(w).trim(); if (/oes$/.test(w)) return w.slice(0, -3) + 'ao'; if (/aes$/.test(w)) return w.slice(0, -3) + 'ao'; if (/(r|z|l)es$/.test(w)) return w.slice(0, -2); if (/s$/.test(w) && w.length > 3) return w.slice(0, -1); return w; }
const sameWord = (a, b) => !!a && !!b && stem(a) === stem(b);
const VERBS = 'conduzir|dirigir|empurrar|puxar|transportar|mover|inserir|engatar|frear|guardar|acomodar|erguer|levantar|verticalizar|arrastar|deslizar|desembalar|embalar|andar|caminhar|deslocar|ir|voltar|retornar|levar|carregar|pegar|apanhar|separar|buscar|retirar|tirar|remover|colocar|posicionar|tampar|depositar|apoiar|soltar|pressionar|encaixar|apertar|travar|curvar|abaixar|agachar|ajoelhar|abrir|fechar|cortar|trocar|abastecer|repor|identificar|etiquetar|ler|bipar|escanear|conferir|inspecionar|montar|empilhar|desempilhar|girar|virar|alinhar|ajustar|dobrar|filmar|amarrar|lacrar|registrar|anotar|aguardar|esperar';
const VERB_RE = new RegExp('^(?:' + VERBS + ')', 'i');
const ACYCLIC_VERBS = /\b(abrir|abertura|abastecer|abastecimento|buscar|busca|repor|reposicao|trocar|troca|identificar|etiquetar|filmar|amarrar|lacrar|montar o pallet|levar o pallet|registrar|anotar|retirar (a )?divisoria)\b/;
const EVENT_WORDS = 'pallet|palete|camada|lote|embalagem|embalagem de origem|caixa de origem|saco|fardo|rolo|bobina|turno|hora|viagem|carrinho|pilha|ordem|pedido';

/* Regras de sugestão de código: só sugere códigos que existem na biblioteca */
const CODE_RULES = [
  { re: /\b(apanhar|pegar|inserir|engatar)\b.*\b(pallet|palete)\b.*\b(paleteira|transpaleteira)\b|\b(paleteira|transpaleteira)\b.*\b(apanhar|pegar|inserir)\b.*\b(pallet|palete)\b/, code: m => (/acert|alinh|90/.test(m) ? 'HAM' : 'HAO') + (/>\s*500|acima de 500|pesad/.test(m) ? 'B' : 'A'), note: 'Apanhar pallet com transpaleteira: confirmar se precisa acertar (HAM) ou não (HAO)', etapa: 'Retirada mecanizada' },
  { re: /\b(iniciar|parar|partida|arrancar|frear)\b.*\b(paleteira|transpaleteira)\b|\b(paleteira|transpaleteira)\b.*\b(iniciar|parar|partida)\b/, code: m => /pesad|>\s*500/.test(m) ? 'HFVB' : 'HFVA', note: 'Retardamento: apanhar alça e partida/parada', etapa: 'Transporte' },
  { re: /\bcurva\b.*\b(paleteira|transpaleteira)\b|\b(paleteira|transpaleteira)\b.*\bcurva\b/, code: m => /pesad|>\s*500/.test(m) ? 'HFKB' : 'HFKA', note: 'Curva de 90° da transpaleteira', etapa: 'Transporte' },
  { re: /\b(conduzir|dirigir|empurrar|puxar|transportar|levar|mover)\b.*\b(paleteira|transpaleteira)\b|\b(paleteira|transpaleteira)\b.*\b(\d+[.,]?\d*)\s*m\b/, code: m => /pesad|>\s*500/.test(m) ? 'HFFB' : 'HFFA', note: 'Transpaleteira por metro: Q = metros', dist: true, etapa: 'Transporte' },
  { re: /\b(retirar|tirar|remover)\b.*\b(tampa|cobertura|divisoria)\b/, code: m => sizeCode('PAD', m), note: 'Retirar tampa/cobertura: conferir dimensão', etapa: 'Retirada' },
  { re: /\b(colocar|posicionar|por)\b.*\b(tampa|cobertura|divisoria)\b|\btampar\b/, code: m => sizeCode('SAD', m), note: 'Colocar tampa/cobertura: conferir dimensão e se o código já inclui apanhar', etapa: 'Colocação' },
  { re: /\b(pressionar|encaixar|apertar|travar)\b/, code: () => 'BA2', note: 'Acionamento simples por pressão: quantidade = nº de pressões', etapa: 'Fixação / encaixe' },
  { re: /\b(curvar|abaixar|agachar|ajoelhar)\b/, code: () => 'KB', note: 'Curvar e voltar', etapa: 'Postura' },
  { re: /\b(andar|caminhar|deslocar|ir ate|voltar|retornar|levar|carregar)\b/, code: () => 'KA', note: 'Quantidade = metros percorridos', dist: true, etapa: 'Deslocamento' },
  { re: /\b(apoiar|depositar|soltar)\b/, code: () => 'PA2', note: 'Colocar no lugar aproximado: conferir distância', etapa: 'Colocação' },
  { re: /\b(pegar|apanhar|separar|buscar)\b/, code: () => 'AC2', note: 'Apanhar e colocar: conferir peso, pega e faixa de distância', etapa: 'Pega' },
];
function plural(w) { w = String(w || '').trim(); if (!w) return w; const n = noAcc(w); if (/s$/.test(n)) return w; if (/ao$/.test(n)) return w.slice(0, -2) + 'ões'; if (/(r|z)$/.test(n)) return w + 'es'; if (/l$/.test(n)) return w.slice(0, -1) + 'is'; if (/m$/.test(n)) return w.slice(0, -1) + 'ns'; return w + 's'; }
function fem(w) { const n = noAcc(w).trim(); return /(a|agem|cao|dade)$/.test(n); }
function sizeCode(prefix, txt) {
  const d = /(\d+)\s*x\s*(\d+)(?:\s*x\s*(\d+))?\s*(mm|cm)?/.exec(txt);
  if (!d) return prefix + 'C';
  const k = d[4] === 'mm' ? 0.1 : 1, mx = Math.max(+d[1], +d[2], +(d[3] || 0)) * k;
  return prefix + (mx <= 30 ? 'A' : mx <= 50 ? 'B' : 'C');
}

function parsePrompt(text, unit, lib) {
  const raw = String(text || '');
  const facts = {}; // facts[evento][item] = quantidade
  const addFact = (ev, item, n) => { ev = stem(ev); item = stem(item); if (!facts[ev]) facts[ev] = {}; facts[ev][item] = n; };
  const T = noAcc(raw);
  let m;
  // "36 caixas por pallet", "6 caixas em cada camada"
  const r1 = /(\d+(?:[.,]\d+)?)\s+([a-z]+)\s+(?:por|em cada|a cada|cada)\s+([a-z]+(?: de (?:origem|destino))?)/g;
  while ((m = r1.exec(T))) addFact(m[3], m[2], +m[1].replace(',', '.'));
  // "embalagem com 420 pecas", "pallet tem 4 camadas"
  const r2 = /\b([a-z]+(?: de (?:origem|destino))?)\s+(?:com|tem|contem|possui)\s+(\d+(?:[.,]\d+)?)\s+([a-z]+)/g;
  while ((m = r2.exec(T))) addFact(m[1], m[3], +m[2].replace(',', '.'));
  // "caixa recebe 6 pecas"
  const r3 = /\b([a-z]+)(?: de (?:origem|destino))?\s+recebe\s+(\d+(?:[.,]\d+)?)\s+([a-z]+)/g;
  while ((m = r3.exec(T))) addFact(m[1], m[3], +m[2].replace(',', '.'));

  // Etapas: quebra por linha, ponto, ponto e vírgula, marcadores e conectores
  let parts = raw.split(/\n+|;|(?<=[a-zà-ú0-9)])\.\s+|(?:^|\s)\d+[).-]\s+|\s+(?:depois|em seguida|e ent[aã]o|ap[oó]s isso)\s*,?\s+/i)
    .map(s => (s || '').replace(/^[\s\-•*,]+|[\s.]+$/g, '')).filter(s => s && s.length > 3);
  // divide "andar até a pilha e pegar 5 tampas" em duas ações — mas não separa "pegar … e colocar …",
  // porque o código de apanhar e colocar já cobre as duas ações
  const steps = [], premises = [];
  let processName = '';
  const firstWord = x => noAcc(x).trim().replace(/^(?:a|o|as|os|cada|uma|um)\s+/, '').split(/\s+/)[0] || '';
  parts = parts.map(p => p.replace(/^\s*\d+\s*[).-]\s*/, ''));
  parts.forEach((p, idx) => {
    const fw = firstWord(p);
    if (!VERB_RE.test(fw)) {
      if (/\d/.test(p)) premises.push(p); else if (!processName && idx === 0) processName = p; else premises.push(p);
      return;
    }
    if (idx === 0 && parts.length > 2 && /^(tampar|embalar|montar|separar|abastecer|expedir|paletizar|etiquetar|carregar|descarregar|conferir)$/.test(fw) && !/\s+e\s+/.test(p)) { processName = p; return; }
    const pieces = p.split(/\s+e\s+/i);
    let acc = '', accVerb = '';
    for (const piece of pieces) {
      const v = noAcc(piece).trim().split(/\s+/)[0] || '';
      const pair = (/^(pegar|apanhar)/.test(accVerb) && /^(colocar|depositar|posicionar|por)$/.test(v)) || (/^(alinhar|inserir|engatar)/.test(accVerb) && /^(apanhar|pegar)$/.test(v) && /paleteira|pallet|palete/.test(noAcc(piece)));
      if (acc && VERB_RE.test(v) && !pair) { steps.push(acc); acc = piece; accVerb = v; }
      else { acc = acc ? acc + ' e ' + piece : piece; if (!accVerb) accVerb = v; }
    }
    if (acc) steps.push(acc);
  });
  const U = stem(unit || '');
  const out = steps.map((s, i) => {
    const t = noAcc(s);
    const st = { id: 'st' + i + '_' + Math.random().toString(36).slice(2, 6), text: s.charAt(0).toUpperCase() + s.slice(1), code: '', note: '', q: '', acyclic: false, event: '', n: null, answer: '', freq: '', source: '', question: '' };
    for (const r of CODE_RULES) {
      const mm = r.re.exec(t);
      if (mm) { const c = r.code(t); if (lib[c]) { st.code = c; st.note = r.note; st.etapa = r.etapa || ''; } if (r.dist) { const d = /(\d+(?:[.,]\d+)?)\s*(m|metros?)\b/.exec(t); if (d) st.q = d[1].replace(',', '.'); } break; }
    }
    // Rateio: "a cada N X"
    let mm2 = /\ba cada\s+(\d+(?:[.,]\d+)?)\s+([a-z]+(?: de (?:origem|destino))?)/.exec(t);
    if (mm2) {
      const N = +mm2[1].replace(',', '.'), W = mm2[2];
      st.acyclic = true;
      if (sameWord(W, U)) { st.n = N; st.source = 'texto: "a cada ' + mm2[1] + ' ' + W + '"'; }
      else { st.event = W; st.mult = N; }
    }
    // "uma vez por pallet", "por camada", "por lote", "por embalagem"
    if (!st.acyclic) {
      const ev = new RegExp('\\b(?:uma vez |1 vez )?(?:por|em cada|cada)\\s+(' + EVENT_WORDS + ')\\b').exec(t);
      if (ev && !sameWord(ev[1], U)) { st.acyclic = true; st.event = ev[1]; }
    }
    // "lote de 5", "5 tampas por vez", "de 5 em 5"
    const lot = /\blote de\s+(\d+)|\b(\d+)\s+[a-z]+\s+(?:por vez|de uma vez|de cada vez)|\bde\s+(\d+)\s+em\s+\3\b/.exec(t);
    if (lot) { st.acyclic = true; if (st.n == null && !st.event) { st.n = +(lot[1] || lot[2] || lot[3]); st.source = 'texto: lote de ' + st.n + ', cada item atende ' + (fem(unit) ? 'uma ' : 'um ') + (unit || 'unidade'); st.needsConfirm = true; st.lot = true; } }
    if (!st.acyclic && ACYCLIC_VERBS.test(t)) st.acyclic = true;
    // Resolve evento com os fatos do texto
    if (st.acyclic && st.n == null && st.event) {
      const E = stem(st.event), mult = st.mult || 1;
      const fk = Object.keys(facts).find(k => k === E || k.startsWith(E + ' ') || E.startsWith(k + ' ')) || E;
      const FE = facts[fk];
      if (FE && FE[U] != null) { st.n = FE[U] * mult; st.source = 'texto: ' + FE[U] + ' ' + plural(unit) + ' por ' + fk; }
      else if (FE && facts[U]) {
        const common = Object.keys(FE).find(k => facts[U][k] != null);
        if (common) { st.freq = facts[U][common] + '/' + (FE[common] * mult); st.source = 'texto: ' + FE[common] + ' ' + plural(common) + ' por ' + fk + ' e ' + facts[U][common] + ' ' + plural(common) + ' por ' + unit; }
      }
    }
    if (st.n != null && !st.freq) st.freq = '1/' + st.n;
    if (st.acyclic) {
      st.answer = st.freq ? (st.n != null ? String(st.n) : st.freq) : '';
    }
    return st;
  });
  // Deslocamentos e apoio ligados à busca do lote acontecem uma vez por lote: mesmo rateio
  out.forEach((st, i) => {
    if (!st.lot && !(st.acyclic && /\b(buscar|busca|abastecer|repor)\b/.test(noAcc(st.text)))) return;
    const join = o => { if (o.acyclic) return; o.acyclic = true; o.groupOf = st.id; o.n = st.n; o.freq = st.freq; o.answer = st.answer;
      o.source = 'mesmo rateio de "' + st.text + '"'; o.needsConfirm = true; o.etapa = 'Abastecimento'; };
    st.etapa = 'Abastecimento';
    const prev = out[i - 1];
    if (prev && prev.code === 'KA') join(prev);
    for (let j = i + 1; j < out.length; j++) {
      const t = noAcc(out[j].text);
      if ((out[j].code === 'KA' && /\b(voltar|retornar|levar|carregar)\b/.test(t)) || /\blote\b/.test(t)) join(out[j]); else break;
    }
  });
  return { steps: out, facts, processName, premises };
}
function stepQuestion(st, unit) {
      if (!st.acyclic) return '';
      const u = unit || 'unidade', qq = fem(u) ? 'quantas' : 'quantos', at = fem(u) ? 'atendidas' : 'atendidos';
      return st.event
        ? '“' + st.text + '” acontece uma vez por ' + st.event + '. ' + qq.charAt(0).toUpperCase() + qq.slice(1) + ' ' + plural(u) + ' são ' + at + ' por ' + st.event + '?'
        : '“' + st.text + '” não acontece em ' + (fem(u) ? 'toda ' : 'todo ') + u + '. Uma ocorrência atende ' + qq + ' ' + plural(u) + '?';
}
function stepFreq(st) {
  if (!st.acyclic) return null;
  const a = String(st.answer || '').trim().replace(',', '.');
  if (!a) return null;
  if (/\//.test(a)) return a.replace(/\s/g, '');
  const n = Number(a); return n > 0 ? '1/' + (Number.isInteger(n) ? n : a) : null;
}

/* ═══════════════════════════════════════════════════════════════════
   ANÁLISE POR VÍDEO — MTM em Foco (100% offline)
   O vídeo é lido no próprio computador (nada é enviado). O sistema mede
   o movimento quadro a quadro, sugere trechos e ciclos, e o analista
   confirma atividade, código, quantidade e frequência de cada linha.
   ═══════════════════════════════════════════════════════════════════ */
const CORE = mvCore();
const SCRIPT_BASE = (document.currentScript && document.currentScript.src) ? document.currentScript.src.replace(/[^\/]*$/, '') : '';
const SEC_PER_TMU = 0.036;
const AGREGA_OPTS = ['Sim', 'Não', 'Necessário'];
const ORIGENS = ['Observado', 'Informado', 'Estimado'];
const EVENT_TYPES = ['Ciclo completo', 'Ciclo parcial', 'Pausa', 'Interferência', 'Espera do método', 'Atividade externa'];
const EXCLUDE_DEFAULT = { 'Pausa': true, 'Interferência': true, 'Atividade externa': true, 'Espera do método': false };

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = v => Math.round(v * 100) / 100;
const fmtS = v => (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(2).replace('.', ',');
const mmss = t => { if (t == null || !isFinite(t)) return '—'; const m = Math.floor(t / 60), s = t - m * 60; return String(m).padStart(2, '0') + ':' + s.toFixed(2).padStart(5, '0').replace('.', ','); };
const uid = () => 'l' + Math.random().toString(36).slice(2, 9);

/* ── Botão na barra do editor ─────────────────────────────────────── */
const anchor = document.querySelector('button[onclick="addSheetHere()"]');
if (!anchor) return;
const button = document.createElement('button');
button.className = 'btn btn-ghost';
button.textContent = 'Análise por vídeo';
button.title = 'Ler um vídeo da operação no computador e montar a análise MTM (offline)';
anchor.after(button);

/* ── Biblioteca técnica (MATRIZ + LIB_CODES do próprio sistema) ──── */
const UAS_SEC = { A: ['2.1 Apanhar e colocar no lugar', '21–32'], P: ['2.2 Colocar no lugar', '33–36'], H: ['2.3 Manuseio de meios auxiliares', '37–42'], B: ['2.4 Acionar', '43–46'], Z: ['2.5 Ciclos de movimento', '47–54'], K: ['2.6 Movimentos do corpo', '55–58'], V: ['2.7 Controle visual', '59–63'] };
const MEK_SEC = { A: ['2.1 Apanhar e colocar no lugar', '19–28'], P: ['2.2 Colocar no lugar', '29–34'], H: ['2.3 Manusear meios auxiliares', '35–42'], B: ['2.4 Acionar', '43–48'], Z: ['2.5 Ciclos de movimento', '49–54'], K: ['2.6 Movimentos do corpo', '55–64'], V: ['2.7 Controle visual', '65–70'] };
let LIB = null;
function library() {
  if (LIB) return LIB;
  LIB = {};
  try { if (typeof MATRIZ !== 'undefined') for (const [c, v] of Object.entries(MATRIZ)) LIB[c] = { code: c, tmu: Number(v.tmu), desc: v.desc, grp: '', doc: 'Biblioteca MATRIZ' }; } catch (e) { }
  try {
    if (typeof LIB_CODES !== 'undefined') for (const v of LIB_CODES) {
      if (LIB[v.code]) { LIB[v.code].grp = LIB[v.code].grp || v.grp; if (Number(v.tmu) !== LIB[v.code].tmu) LIB[v.code].conflict = Number(v.tmu); }
      else LIB[v.code] = { code: v.code, tmu: Number(v.tmu), desc: v.desc, grp: v.grp || '', doc: 'Biblioteca LIB_CODES' };
    }
  } catch (e) { }
  for (const it of Object.values(LIB)) {
    const d = (it.desc || '').toLowerCase();
    it.unit = it.code === 'PT' ? 'minuto (1666,67 TMU = 60 s)' : /por metro|\/\s*m\b|metro percorrido/.test(d) ? 'metro' : /por grau|\bgrau/.test(d) ? 'conforme descrição' : 'ocorrência';
    it.family = it.grp || familyName(it.code);
  }
  return LIB;
}
function familyName(code) {
  try { if (typeof MTM_CATEGORIES !== 'undefined') { const k = Object.keys(MTM_CATEGORIES).filter(k => k !== '-' && code.startsWith(k)).sort((a, b) => b.length - a.length)[0]; if (k) return MTM_CATEGORIES[k].name; } } catch (e) { }
  return 'Outros';
}
function systemOf(code) {
  if (/^[APHBZKV][A-Z]?\d$/.test(code)) return 'UAS';
  if (/^[APHBZKV][A-Z]{2}$/.test(code)) return 'MEK';
  return 'Logística / complementar';
}
function defaultSource(code, sys) {
  const it = library()[code]; if (!it) return '';
  const s = sys === 'MEK' ? MEK_SEC : sys === 'UAS' ? UAS_SEC : null;
  const base = 'MTM em Foco — ' + it.doc + (it.grp ? ' (grupo ' + it.grp + ')' : '');
  if (s && /^[APHBZKV]/.test(code) && systemOf(code) !== 'Logística / complementar') {
    const sec = s[code[0]];
    return base + ' · Apostila ' + sys + ' seção ' + sec[0] + ', p. ' + sec[1] + ' (conferir)';
  }
  return base + ' · página não localizada nas apostilas embutidas (informar)';
}

/* ── Estado ───────────────────────────────────────────────────────── */
function freshState() {
  return { unit: '', unitRef: '', unitsPerCycle: 1, process: '', system: 'UAS', filename: '', duration: 0, coverage: '',
           analysis: null, samples: [], events: [], lines: [], improvements: [], sources: {}, refRange: 'auto', readMode: 'precisa', prompt: '', steps: [], premises: [], params: [] };
}
function lineCalc(l) {
  const it = library()[l.code];
  const tmu = l.code === 'PT' ? 1666.67 : (it ? it.tmu : NaN);
  const q = CORE.num(l.q, NaN), f = CORE.num(l.f, NaN);
  const fEff = l.simul ? 0 : f;
  const ttmu = tmu * q * fEff;
  return { tmu, q, f, fEff, ttmu, sec: ttmu * SEC_PER_TMU, valid: isFinite(ttmu) };
}
function totals(st) {
  let tmu = 0; for (const l of st.lines) { const c = lineCalc(l); if (c.valid) tmu += c.ttmu; }
  return { tmu, sec: tmu * SEC_PER_TMU };
}
/* Tempo observado comparável, com o mesmo rateio do MTM */
function observed(st) {
  const cycles = st.events.filter(e => e.type === 'Ciclo completo' && e.use && e.end > e.start);
  const excl = st.events.filter(e => e.type !== 'Ciclo completo' && e.type !== 'Ciclo parcial' && e.exclude);
  CUR_UPC = Math.max(1e-9, CORE.num(st.unitsPerCycle, 1));
  const acyc = st.lines.filter(l => isAcyclic(l) && l.end > l.start);
  const ov = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const per = cycles.map(c => {
    const exc = excl.reduce((s, e) => s + ov(c.start, c.end, e.start, e.end), 0);
    const acy = acyc.reduce((s, l) => s + ov(c.start, c.end, l.start, l.end), 0);
    return { id: c.id, start: c.start, end: c.end, gross: c.end - c.start, exc, acy, net: c.end - c.start - exc, cyclic: c.end - c.start - exc - acy };
  });
  const upc = Math.max(1e-9, CORE.num(st.unitsPerCycle, 1)); CUR_UPC = upc;
  const meanNet = per.length ? per.reduce((s, p) => s + p.net, 0) / per.length : null;
  const meanCyclic = per.length ? per.reduce((s, p) => s + p.cyclic, 0) / per.length : null;
  const acycRateado = acyc.reduce((s, l) => s + (l.end - l.start) * lineCalc(l).f, 0);
  const comparable = per.length ? meanCyclic / upc + acycRateado : null;
  return { per, meanNet, meanCyclic, upc, acyc, acycRateado, comparable, n: per.length };
}
/* Acíclica: ocorre menos de uma vez por ciclo observado (frequência menor que 1 ÷ unidades por ciclo) */
let CUR_UPC = 1;
function isAcyclic(l) { const f = CORE.num(l.f, 1); return !l.simul && f < (1 / CUR_UPC) - 1e-9; }

/* ── Amostragem do vídeo no navegador ────────────────────────────── */
function grabber(video) {
  const W = 64, H = Math.max(16, Math.round(64 * (video.videoHeight || 9) / (video.videoWidth || 16)));
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  return { W, H, grab() { ctx.drawImage(video, 0, 0, W, H); const d = ctx.getImageData(0, 0, W, H).data, g = new Uint8Array(W * H); for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (d[p] * 77 + d[p + 1] * 150 + d[p + 2] * 29) >> 8; return g; } };
}
function waitEvent(target, ev, signal, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => done(new Error('Tempo esgotado ao ler o vídeo.')), ms || 20000);
    const ok = () => done(), bad = () => done(new Error('O navegador não conseguiu ler este vídeo.')), ab = () => done(new DOMException('abort', 'AbortError'));
    function done(err) { clearTimeout(t); target.removeEventListener(ev, ok); target.removeEventListener('error', bad); signal && signal.removeEventListener('abort', ab); err ? rej(err) : res(); }
    target.addEventListener(ev, ok, { once: true }); target.addEventListener('error', bad, { once: true });
    signal && signal.addEventListener('abort', ab, { once: true });
  });
}
async function sampleVideo(video, signal, fast, progress) {
  const g = grabber(video), out = [], dur = video.duration, step = 0.2; // 5 amostras/s
  let prev = null, lastT = -1;
  const push = t => {
    const cur = g.grab();
    if (prev) out.push(Object.assign({ t }, CORE.frameMotion(prev, cur, g.W, g.H)));
    else out.push({ t, energy: 0, cam: 0, zones: new Array(9).fill(0), cx: .5, cy: .5 });
    prev = cur; lastT = t;
  };
  // Modo rápido: reprodução acelerada e muda, capturando os quadros exibidos
  if (fast && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    const ok = await new Promise(resolve => {
      let frames = 0, stall = null, finished = false;
      const finish = v => { if (finished) return; finished = true; clearInterval(stall); video.pause(); video.removeEventListener('ended', onEnd); resolve(v); };
      const onEnd = () => finish(true);
      const cb = (now, meta) => {
        if (finished) return;
        if (signal.aborted) return finish(false);
        frames++;
        if (meta.mediaTime - lastT >= step * 0.9) { push(meta.mediaTime); progress(meta.mediaTime / dur); }
        video.requestVideoFrameCallback(cb);
      };
      let lastFrames = -1;
      stall = setInterval(() => { if (frames === lastFrames) finish(frames > 10 && video.currentTime >= dur - 0.5); lastFrames = frames; }, 4000);
      video.addEventListener('ended', onEnd);
      video.muted = true; video.currentTime = 0; video.playbackRate = 4;
      video.requestVideoFrameCallback(cb);
      video.play().catch(() => finish(false));
    });
    video.playbackRate = 1;
    if (signal.aborted) throw new DOMException('abort', 'AbortError');
    if (ok && out.length > dur * 2) return out;
    out.length = 0; prev = null; lastT = -1; // cai para o modo por busca
  }
  // Modo compatível: busca quadro a quadro
  const n = Math.min(9000, Math.max(4, Math.ceil(dur / step)));
  for (let i = 0; i < n; i++) {
    if (signal.aborted) throw new DOMException('abort', 'AbortError');
    const t = (i + 0.5) * dur / n;
    const p = waitEvent(video, 'seeked', signal, 15000); video.currentTime = t; await p;
    push(t); if (i % 5 === 0) progress(i / n);
  }
  return out;
}

/* ── Interface ───────────────────────────────────────────────────── */
const CSS = `
dialog.mv{box-sizing:border-box;width:min(1500px,98vw);height:min(960px,96vh);max-width:none;max-height:none;margin:auto;padding:0;border:1px solid #344c66;border-radius:14px;background:#0d2034;color:#edf5ff;font:13px/1.4 Poppins,system-ui,sans-serif;box-shadow:0 20px 64px #0008}
dialog.mv::backdrop{background:rgba(3,12,24,.78)}
.mv *{box-sizing:border-box}
.mv .top{display:flex;align-items:center;gap:12px;padding:10px 16px;background:#0a1a2c;border-bottom:1px solid #26405c}
.mv .top h3{margin:0;font-size:16px}.mv .top .scope{color:#9fb7d0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mv .body{display:grid;grid-template-columns:minmax(360px,34%) 1fr;height:calc(100% - 50px)}
.mv .left{padding:12px 14px;overflow:auto;border-right:1px solid #26405c}
.mv .right{display:flex;flex-direction:column;min-width:0;overflow:hidden}
.mv label{font-weight:600;font-size:12px;color:#c8daee}
.mv input,.mv select,.mv textarea{font:inherit;color:#fff;background:#091827;border:1px solid #4a6580;border-radius:6px;padding:5px 7px;min-width:0}
.mv input:focus,.mv select:focus,.mv textarea:focus{outline:2px solid #78c6ff;outline-offset:0}
.mv button{font:inherit;cursor:pointer;border-radius:7px;border:1px solid #4a6580;background:#16304b;color:#e6f1ff;padding:5px 10px}
.mv button:hover{background:#1d3d5f}.mv button.pri{background:#89ceff;color:#081c30;border:0;font-weight:700}
.mv button:disabled{opacity:.45;cursor:not-allowed}
.mv .q{background:#132c46;border:1px solid #3d6b96;border-radius:10px;padding:10px;margin-bottom:10px}
.mv .q .ask{font-weight:800;font-size:13px;color:#ffd78a;margin-bottom:6px;letter-spacing:.2px}
.mv .grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:6px 8px}.mv .grid2>div{display:flex;flex-direction:column;gap:3px;min-width:0}.mv .grid2 input,.mv .grid2 select{width:100%}
.mv video{width:100%;max-height:250px;background:#000;border-radius:8px;margin-top:8px}
.mv canvas.tl{width:100%;height:84px;display:block;margin-top:6px;background:#081626;border-radius:6px;cursor:pointer}
.mv .bar{height:6px;background:#1b3550;border-radius:4px;overflow:hidden;margin-top:6px}.mv .bar>i{display:block;height:100%;width:0;background:#89ceff}
.mv .status{margin:6px 0;color:#b8cbe0;min-height:18px}.mv .status.err{color:#ffb4ac}
.mv .sum{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:10px}
.mv .sum div{background:#0a1a2c;border:1px solid #26405c;border-radius:8px;padding:6px 8px}.mv .sum b{display:block;font-size:16px}.mv .sum span{font-size:11px;color:#9fb7d0}
.mv .tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid #26405c;flex-wrap:wrap}
.mv .tabs button{border-radius:8px 8px 0 0;border-bottom:0}.mv .tabs button[aria-selected=true]{background:#2e75b6;border-color:#2e75b6}
.mv .pane{flex:1;overflow:auto;padding:10px 12px}
.mv table{border-collapse:collapse;width:100%;font-size:12px}.mv table.lines{min-width:1900px}.mv td.mm{white-space:nowrap;font-size:11px}
.mv th{position:sticky;top:0;background:#2e75b6;color:#fff;padding:5px;text-align:left;z-index:1;font-weight:600;white-space:nowrap}
.mv td{border-bottom:1px solid #22384f;padding:3px 4px;vertical-align:top}
.mv td input,.mv td select{width:100%;padding:3px 5px}
.mv tr.cur td{background:#183a5a}.mv tr.bad td:first-child{box-shadow:inset 4px 0 0 #ff8a80}.mv tr.low td:nth-child(2){box-shadow:inset 3px 0 0 #ffd78a}
.mv .num{text-align:right;white-space:nowrap}.mv .mut{color:#8fa8c0;font-size:11px}
.mv .acts{display:flex;gap:3px;flex-wrap:nowrap}.mv .acts button{padding:2px 6px;font-size:11px}
.mv .tot td{font-weight:800;background:#10263d;border-top:2px solid #2e75b6}
.mv .tb{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.mv .warn{background:#3a2a12;border:1px solid #8a6a2a;color:#ffe2a8;border-radius:8px;padding:8px;margin:8px 0;white-space:pre-wrap}
.mv .ok{background:#12352a;border:1px solid #2a8a5f;color:#bff5dc;border-radius:8px;padding:8px;margin:8px 0}
@media (max-width:900px){.mv .body{grid-template-columns:1fr}.mv .left{border-right:0;border-bottom:1px solid #26405c;max-height:55%}}
`;

button.onclick = () => openDialog();

function openDialog() {
  const project = getActiveProject();
  if (!project) { alert('Abra uma pasta e um projeto antes de usar a análise por vídeo.'); return; }
  const folderId = activeProjectCtx.folderId, projectId = project.id;
  const sameProject = () => activeProjectCtx && activeProjectCtx.folderId === folderId && getActiveProject() && getActiveProject().id === projectId;
  let st = freshState();
  st.process = '';
  let url = null, controller = null, savedSheetId = null;

  const dlg = document.createElement('dialog');
  dlg.className = 'mv';
  dlg.innerHTML = `<style>${CSS}</style>
  <div class="top"><h3>Análise por vídeo</h3><div class="scope"></div><button data-x>Fechar</button></div>
  <div class="body">
    <div class="left">
      <div class="q">
        <div class="ask">QUAL SERÁ A UNIDADE DE REFERÊNCIA DESTA ANÁLISE?</div>
        <div class="grid2">
          <div><label>Unidade de referência *</label><input data-k="unit" list="mv-units" placeholder="caixa, peça, saco, pallet…"></div>
          <div><label>Qual embalagem é a referência?</label><input data-k="unitRef" placeholder="ex.: caixa de destino"></div>
          <div><label>Unidades por ciclo observado</label><input data-k="unitsPerCycle" inputmode="decimal" placeholder="1"></div>
          <div><label>Sistema MTM</label><select data-k="system"><option>UAS</option><option>MEK</option><option>Logística</option></select></div>
          <div style="grid-column:1/-1"><label>Leitura do vídeo</label><select data-k="readMode"><option value="precisa">Precisa — mesmo resultado a cada leitura (≈ duração do vídeo)</option><option value="rapida">Rápida — cerca de 4× mais rápida, cortes podem variar</option></select></div>
          <div style="grid-column:1/-1"><label>Processo</label><input data-k="process" placeholder="ex.: Tampar caixas no pallet"></div>
        </div>
        <datalist id="mv-units"><option>caixa</option><option>peça</option><option>saco</option><option>embalagem</option><option>camada</option><option>pallet</option><option>lote</option><option>operação</option><option>ciclo</option></datalist>
      </div>
      <div class="q">
        <div class="ask">DESCREVA A OPERAÇÃO (O QUE VOCÊ QUER ANALISAR)</div>
        <textarea data-k="prompt" rows="5" style="width:100%;resize:vertical" placeholder="${esc(PROMPT_EXAMPLE)}"></textarea>
        <div class="tb" style="margin:6px 0 0"><button data-parse>Interpretar descrição</button><span class="mut">Monta o roteiro, sugere códigos e pergunta o rateio das etapas acíclicas. Interpretação offline, por regras.</span></div>
      </div>
      <div class="saved"></div>
      <label>Vídeo da operação (lido no computador, nada é enviado)</label>
      <input type="file" accept="video/*,.mp4,.mov,.m4v,.webm,.avi,.mkv" data-file style="width:100%;margin-top:4px">
      <video playsinline controls preload="metadata"></video>
      <canvas class="tl" title="Clique para ir ao ponto do vídeo"></canvas>
      <div class="bar"><i></i></div>
      <div class="status" role="status"></div>
      <div class="tb">
        <button data-mark="start" title="Marca o início de um ciclo no ponto atual do vídeo">Início de ciclo aqui</button>
        <button data-mark="end" title="Fecha o último ciclo aberto no ponto atual">Fim de ciclo aqui</button>
        <button data-mark="split" title="Divide a linha de movimento que contém o ponto atual">Dividir movimento aqui</button>
      </div>
      <div class="sum"></div>
      <div class="tb" style="margin-top:10px"><button class="pri" data-save>Gravar na folha do projeto</button><button class="pri" data-xlsx>Exportar Excel</button></div>
      <div class="check"></div>
    </div>
    <div class="right">
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="rot" aria-selected="false">Roteiro e rateios <span data-pend></span></button>
        <button role="tab" data-tab="mov" aria-selected="true">Movimentos (MTM)</button>
        <button role="tab" data-tab="cro" aria-selected="false">Cronoanálise</button>
        <button role="tab" data-tab="pre" aria-selected="false">Premissas</button>
        <button role="tab" data-tab="cod" aria-selected="false">Códigos e fontes</button>
        <button role="tab" data-tab="mel" aria-selected="false">Melhorias</button>
      </div>
      <div class="pane" data-pane="rot" hidden></div>
      <div class="pane" data-pane="mov"></div>
      <div class="pane" data-pane="cro" hidden></div>
      <div class="pane" data-pane="pre" hidden></div>
      <div class="pane" data-pane="cod" hidden></div>
      <div class="pane" data-pane="mel" hidden></div>
    </div>
  </div>
  <datalist id="mv-codes"></datalist><datalist id="mv-hist"></datalist>`;
  document.body.append(dlg);
  const $ = s => dlg.querySelector(s);
  $('.scope').textContent = (pmData[folderId] ? pmData[folderId].name : '') + ' / ' + project.name;
  const video = $('video'), canvas = $('canvas.tl'), statusEl = $('.status'), barEl = $('.bar>i');
  const panes = { rot: $('[data-pane=rot]'), mov: $('[data-pane=mov]'), cro: $('[data-pane=cro]'), pre: $('[data-pane=pre]'), cod: $('[data-pane=cod]'), mel: $('[data-pane=mel]') };
  const setStatus = (t, err) => { statusEl.textContent = t || ''; statusEl.classList.toggle('err', !!err); };

  // Códigos da biblioteca e histórico do projeto
  const lib = library();
  $('#mv-codes').innerHTML = Object.values(lib).map(it => `<option value="${esc(it.code)}">${esc(it.code)} · ${esc(it.tmu)} TMU · ${esc(it.desc)}</option>`).join('');
  const history = [];
  const histFeat = [];
  for (const sh of scopedSheets()) {
    for (const r of (sh.rows || [])) if (r.code && r.desc) history.push({ desc: r.desc, code: r.code, agrega: r.agrega, sheet: sh.label });
    const vm = sh.header && sh.header.videoMtm;
    if (vm && Array.isArray(vm.segments)) for (const sg of vm.segments) {
      const row = (sh.rows || []).find(r => r.id === sg.rowId);
      if (row && Array.isArray(sg.features) && sg.features.length >= 11) histFeat.push({ f: sg.features, desc: row.desc, code: row.code, agrega: row.agrega, sheet: sh.label });
    }
  }
  const histMap = new Map(); history.forEach(h => { if (!histMap.has(h.desc)) histMap.set(h.desc, h); });
  function fillDescList() {
    $('#mv-hist').innerHTML = st.steps.map((x, i) => `<option value="${esc(x.text)}">Roteiro ${i + 1}${x.code ? ' · ' + esc(x.code) : ''}${x.acyclic ? ' · acíclica' : ''}</option>`).join('')
      + [...histMap.values()].map(h => `<option value="${esc(h.desc)}">${esc(h.code)} · ${esc(h.sheet)}</option>`).join('');
  }
  fillDescList();

  // Análises gravadas anteriormente neste projeto
  const savedList = scopedSheets().filter(s => s.header && s.header.videoMtm && Array.isArray(s.header.videoMtm.lines));
  if (savedList.length) {
    const box = $('.saved');
    box.innerHTML = '<label>Análises por vídeo já gravadas neste projeto</label>';
    savedList.forEach(s => {
      const b = document.createElement('button'); b.style.margin = '4px 4px 8px 0';
      b.textContent = 'Abrir ' + s.label; b.onclick = () => { loadSaved(s); };
      box.append(b);
    });
  }
  function loadSaved(s) {
    const vm = s.header.videoMtm;
    st = Object.assign(freshState(), JSON.parse(JSON.stringify(vm)), { analysis: null, samples: [] });
    savedSheetId = s.id;
    syncForm(); renderAll();
    setStatus('Análise gravada carregada (' + (vm.filename || 'vídeo') + '). Para ver os trechos, selecione o mesmo vídeo novamente; a análise gravada é mantida.');
  }

  // Formulário da unidade
  function syncForm() { dlg.querySelectorAll('[data-k]').forEach(el => { el.value = st[el.dataset.k] == null ? '' : st[el.dataset.k]; }); }
  syncForm();
  dlg.querySelectorAll('[data-k]').forEach(el => el.addEventListener('input', () => {
    st[el.dataset.k] = el.value;
    if (el.dataset.k === 'system') renderCodes();
    renderLinesTotals(); renderSummary(); if (el.dataset.k === 'unitsPerCycle') renderCro(); if (el.dataset.k === 'unit') renderRot();
  }));

  // Abas
  dlg.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => {
    dlg.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    for (const k in panes) panes[k].hidden = k !== b.dataset.tab;
    if (b.dataset.tab === 'cod') renderCodes();
    if (b.dataset.tab === 'rot') renderRot();
    if (b.dataset.tab === 'pre') renderPre();
  });
  const showTab = k => dlg.querySelector('[data-tab=' + k + ']').click();

  const close = () => dlg.close();
  $('[data-x]').onclick = close;
  dlg.addEventListener('cancel', e => { if (st.lines.length && !confirm('Fechar a análise? O que não foi gravado será perdido.')) e.preventDefault(); });
  dlg.onclose = () => { controller && controller.abort(); video.pause(); video.removeAttribute('src'); video.load(); if (url) URL.revokeObjectURL(url); dlg.remove(); };

  /* ── Leitura do vídeo ── */
  $('[data-file]').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    controller && controller.abort(); controller = new AbortController();
    const signal = controller.signal;
    if (url) URL.revokeObjectURL(url);
    url = URL.createObjectURL(file);
    const keep = st.lines.length > 0 && st.filename === file.name;
    if (!keep) { st.lines = []; st.events = []; st.improvements = []; savedSheetId = null; }
    st.filename = file.name; st.analysis = null; st.samples = [];
    renderAll();
    setStatus('Abrindo ' + file.name + ' (' + (file.size / 1048576).toFixed(0) + ' MB)…');
    try {
      const p = waitEvent(video, 'loadeddata', signal, 30000);
      video.src = url; video.load(); await p;
      if (!isFinite(video.duration) || video.duration <= 0) throw new Error('O arquivo não tem duração legível.');
      if (!video.videoWidth) throw new Error('O arquivo não tem imagem legível.');
      st.duration = video.duration;
      video.controls = false;
      const t0 = performance.now();
      const samples = await sampleVideo(video, signal, st.readMode === 'rapida', f => { barEl.style.width = Math.min(100, f * 100).toFixed(1) + '%'; setStatus('Lendo o movimento no computador: ' + Math.round(f * 100) + '%'); });
      barEl.style.width = '100%';
      st.samples = samples;
      st.analysis = CORE.analyze(samples, st.duration);
      video.controls = true; video.muted = false; video.currentTime = 0;
      if (!keep) seedFromAnalysis();
      renderAll();
      const a = st.analysis;
      setStatus('Leitura concluída em ' + ((performance.now() - t0) / 1000).toFixed(0) + ' s: ' + a.segments.length + ' trechos'
        + (a.period ? ', repetição sugerida a cada ~' + fmtS(a.period) + ' s (confiança ' + Math.round(a.confidence * 100) + '%).' : ', sem repetição clara.')
        + ' Confira cada trecho no vídeo e preencha atividade e código.');
    } catch (err) {
      video.controls = true;
      if (err && err.name === 'AbortError') return;
      let msg = err && err.message || String(err);
      if (/não conseguiu ler/.test(msg)) msg += ' Se o vídeo for de iPhone (HEVC/H.265) ou de câmera industrial, converta para MP4 (H.264) e tente de novo.';
      setStatus(msg, true);
    }
  };

  function seedFromAnalysis() {
    const a = st.analysis;
    st.events = a.cycles.map((c, i) => ({ id: uid(), type: 'Ciclo completo', start: c.start, end: c.end, use: false,
      reason: 'Sugestão automática por repetição do movimento — confirmar início e fim no vídeo' + ((i === 0 && c.start < 0.5) ? '; o vídeo pode ter começado no meio do ciclo' : '') + ((i === a.cycles.length - 1 && st.duration - c.end < 0.5) ? '; o vídeo pode ter terminado no meio do ciclo' : ''), exclude: false }));
    st.coverage = 'Filmagem de ' + mmss(0) + ' a ' + mmss(st.duration) + '. Verificar se começa e termina em limite de ciclo.';
    buildLines(0, st.duration);
  }
  function buildLines(t0, t1) {
    const a = st.analysis; if (!a) return;
    const upc = CORE.num(st.unitsPerCycle, 1);
    st.lines = a.segments.filter(s => s.end > t0 && s.start < t1).map(s => {
      const l = { id: uid(), start: Math.max(t0, s.start), end: Math.min(t1, s.end), desc: '', agrega: '', code: '', q: '1', f: upc > 1 ? '1/' + upc : '1',
        origin: 'Observado', simul: false, simulWith: '', etapa: '', dist: '', obs: '', features: s.features, kind: s.kind };
      if (s.kind === 'pausa') l.obs = 'Baixa movimentação visível — confirmar se é espera, pausa ou movimento fino/distante';
      if (s.camera > 0.3) l.obs = (l.obs ? l.obs + '; ' : '') + 'câmera em movimento neste trecho';
      if (histFeat.length && s.features) {
        let best = null, bd = Infinity;
        for (const h of histFeat) { const d = CORE.featDist(h.f, s.features); if (d < bd) { bd = d; best = h; } }
        if (best) { l.desc = best.desc; l.code = best.code; l.agrega = best.agrega || ''; l.origin = 'Estimado'; l.obs = (l.obs ? l.obs + '; ' : '') + 'sugerido por semelhança com "' + best.sheet + '" — conferir no vídeo'; }
      }
      return l;
    });
  }

  /* ── Marcações pelo ponto atual do vídeo ── */
  dlg.querySelectorAll('[data-mark]').forEach(b => b.onclick = () => {
    const t = r2(video.currentTime || 0);
    if (b.dataset.mark === 'start') { st.events.push({ id: uid(), type: 'Ciclo completo', start: t, end: t, use: false, exclude: false, reason: 'Marcado pelo analista — definir o fim' }); }
    if (b.dataset.mark === 'end') {
      const open = [...st.events].reverse().find(e => e.type === 'Ciclo completo' && e.end <= e.start && t > e.start);
      if (!open) { setStatus('Nenhum ciclo aberto antes deste ponto. Use "Início de ciclo aqui" primeiro.', true); return; }
      open.end = t; open.use = true; open.reason = 'Início e fim marcados pelo analista no vídeo';
    }
    if (b.dataset.mark === 'split') {
      const i = st.lines.findIndex(l => t > l.start + 0.05 && t < l.end - 0.05);
      if (i < 0) { setStatus('O ponto atual não está dentro de uma linha de movimento.', true); return; }
      const l = st.lines[i], n = Object.assign({}, l, { id: uid(), start: t, desc: '', code: '', origin: 'Observado', obs: '' });
      l.end = t; st.lines.splice(i + 1, 0, n);
    }
    renderAll();
  });

  /* ── Linha do tempo ── */
  function drawTimeline() {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth || 400, h = canvas.clientHeight || 84;
    canvas.width = w * dpr; canvas.height = h * dpr;
    const c = canvas.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const D = st.duration || 1, X = t => t / D * w;
    for (const e of st.events) {
      if (e.end <= e.start) continue;
      c.fillStyle = e.type === 'Ciclo completo' ? (e.use ? 'rgba(80,200,140,.28)' : 'rgba(80,200,140,.12)') : e.exclude ? 'rgba(255,120,110,.3)' : 'rgba(255,215,138,.2)';
      c.fillRect(X(e.start), 0, X(e.end) - X(e.start), h);
    }
    const a = st.analysis;
    if (a && a.signal.length) {
      c.strokeStyle = '#89ceff'; c.lineWidth = 1.2; c.beginPath();
      a.signal.forEach((v, i) => { const x = (i + 0.5) / a.signal.length * w, y = h - 4 - Math.min(1.3, v) / 1.3 * (h - 18); i ? c.lineTo(x, y) : c.moveTo(x, y); });
      c.stroke();
    }
    c.fillStyle = '#c8daee'; c.font = '10px Poppins,sans-serif';
    st.lines.forEach((l, i) => { c.fillStyle = 'rgba(255,255,255,.35)'; c.fillRect(X(l.start), h - 12, 1, 12); c.fillStyle = '#c8daee'; if (X(l.end) - X(l.start) > 14) c.fillText(String(i + 1), X(l.start) + 2, 11); });
    c.fillStyle = '#ffd78a'; c.fillRect(X(video.currentTime || 0) - 1, 0, 2, h);
  }
  canvas.onclick = e => { if (!st.duration) return; const r = canvas.getBoundingClientRect(); video.currentTime = (e.clientX - r.left) / r.width * st.duration; };
  let raf = 0;
  const tick = () => { drawTimeline(); highlightCurrent(); raf = video.paused ? 0 : requestAnimationFrame(tick); };
  video.addEventListener('play', () => { if (!raf) raf = requestAnimationFrame(tick); });
  video.addEventListener('seeked', () => { drawTimeline(); highlightCurrent(); });
  function highlightCurrent() {
    const t = video.currentTime || 0;
    panes.mov.querySelectorAll('tr[data-i]').forEach(tr => { const l = st.lines[+tr.dataset.i]; tr.classList.toggle('cur', !!l && t >= l.start && t < l.end); });
  }
  let stopAt = null;
  video.addEventListener('timeupdate', () => { if (stopAt != null && video.currentTime >= stopAt) { video.pause(); stopAt = null; } });
  function playRange(a, b) { if (!video.src) { setStatus('Selecione o vídeo para ver o trecho.', true); return; } video.currentTime = a; stopAt = b; video.play().catch(() => { }); }


  /* ── Descrição da operação → roteiro e rateios ── */
  function defaultF() { const upc = CORE.num(st.unitsPerCycle, 1); return upc > 1 ? '1/' + st.unitsPerCycle : '1'; }
  function rateioNote(x) {
    const f = stepFreq(x); if (!x.acyclic || !f) return '';
    const src = x.edited ? 'informado pelo usuário' : (x.source || 'informado') + (x.needsConfirm ? (x.confirmed ? ', confirmado pelo usuário' : ', a confirmar') : '');
    return 'Rateio: frequência ' + f + ' por ' + (st.unit || 'unidade') + ' (' + src + ')';
  }
  const paramById = id => st.params.find(p => p.id === id);
  function linkLine(l, x) {
    l.stepId = x.id; l.desc = x.text;
    if (!l.code && x.code) l.code = x.code;
    if (x.etapa && !l.etapa) l.etapa = x.etapa;
    if ((!l.q || l.q === '1') && x.q) l.q = x.q;
    applyStepToLine(l, x);
  }
  /* Cria/atualiza os parâmetros (aba Premissas) a partir do roteiro: distâncias e rateios */
  function syncParams() {
    const u = st.unit || 'unidade', used = new Set();
    st.steps.forEach(x => {
      const it = lib[x.code];
      if (it && it.unit === 'metro') {
        const id = 'pq_' + x.id; let p = paramById(id);
        if (!p) { p = { id, name: 'Percurso — ' + x.text, value: x.q || '', unit: 'm', origin: x.q ? 'Informado na descrição da operação' : 'A informar' }; st.params.push(p); }
        x.qParam = id; used.add(id);
      } else x.qParam = '';
    });
    st.steps.forEach(x => {
      if (!x.acyclic) { x.fParam = ''; return; }
      const root = (x.groupOf && st.steps.find(o => o.id === x.groupOf && o.acyclic)) || x;
      const a = String(root.answer || '').trim().replace(',', '.');
      if (!a || /\//.test(a) || !(Number(a) > 0)) { x.fParam = ''; return; }
      const id = 'pf_' + root.id; let p = paramById(id);
      const origin = root.edited ? 'Informado pelo usuário' : (root.source || 'Informado') + (root.needsConfirm ? (root.confirmed ? ', confirmado pelo usuário' : ' — a confirmar') : '');
      if (!p) { p = { id, name: plural(u).charAt(0).toUpperCase() + plural(u).slice(1) + ' atendidas por ocorrência — ' + root.text, value: a, unit: plural(u), origin }; st.params.push(p); }
      else if (!p.userEdited) { p.value = a; p.origin = origin; }
      x.fParam = id; used.add(id);
    });
    st.params = st.params.filter(p => !/^p[qf]_/.test(p.id) || used.has(p.id));
    // propaga para as linhas
    st.lines.forEach(l => {
      const x = l.stepId && st.steps.find(o => o.id === l.stepId); if (!x) return;
      l.qParam = x.qParam || ''; l.fParam = x.fParam || '';
      const pq = l.qParam && paramById(l.qParam); if (pq && String(pq.value).trim() !== '') l.q = String(pq.value);
    });
  }
  function applyStepToLine(l, x) {
    const f = stepFreq(x);
    l.obs = String(l.obs || '').replace(/Rateio:[^;]*(;\s*)?/g, '').trim();
    if (x.acyclic) { l.f = f || ''; const n = rateioNote(x); if (n) l.obs = n + (l.obs ? '; ' + l.obs : ''); if (f) l.origin = l.origin === 'Estimado' ? 'Informado' : l.origin; }
    else if (!l.f || CORE.num(l.f, 1) < 1 / Math.max(1, CORE.num(st.unitsPerCycle, 1)) - 1e-9) l.f = defaultF();
  }
  function applyStep(x) {
    syncParams();
    st.lines.filter(l => l.stepId === x.id).forEach(l => applyStepToLine(l, x));
    // etapas do mesmo grupo (ex.: deslocamentos para buscar o lote) seguem a resposta, se não foram editadas
    st.steps.filter(o => o.groupOf === x.id && o.acyclic && !o.edited && o.answer !== x.answer).forEach(o => { o.answer = x.answer; o.source = 'mesmo rateio de "' + x.text + '"'; applyStep(o); });
  }
  $('[data-parse]').onclick = () => {
    const txt = String(st.prompt || '').trim();
    if (!txt) { setStatus('Escreva a descrição da operação primeiro.', true); return; }
    if (st.steps.some(x => x.answer || st.lines.some(l => l.stepId === x.id)) && !confirm('Interpretar de novo substitui o roteiro atual e desfaz o vínculo das linhas. Continuar?')) return;
    const r = parsePrompt(txt, st.unit || 'unidade', lib);
    st.lines.forEach(l => { l.stepId = ''; });
    st.steps = r.steps; st.premises = r.premises; st.params = st.params.filter(p => !/^p[qf]_/.test(p.id)); syncParams();
    if (r.processName && !String(st.process || '').trim()) { st.process = r.processName; syncForm(); }
    const pend = st.steps.filter(x => x.acyclic && !stepFreq(x)).length;
    setStatus('Roteiro com ' + st.steps.length + ' etapas; ' + st.steps.filter(x => x.acyclic).length + ' acíclicas' + (pend ? ', ' + pend + ' com rateio a responder.' : '.'));
    renderAll(); showTab('rot');
  };
  function renderRot() {
    const u = st.unit || 'unidade';
    const pend = st.steps.filter(x => x.acyclic && (!stepFreq(x) || (x.needsConfirm && !x.confirmed)));
    const pendDist = st.steps.filter(x => x.qParam && paramById(x.qParam) && String(paramById(x.qParam).value).trim() === '');
    const badge = dlg.querySelector('[data-pend]'); if (badge) badge.textContent = (pend.length + pendDist.length) ? '(' + (pend.length + pendDist.length) + ')' : '';
    let h = '';
    if (!st.steps.length) { panes.rot.innerHTML = '<p class="mut">Escreva a descrição da operação no campo à esquerda e clique em "Interpretar descrição". As etapas aparecem aqui, com o código sugerido e as perguntas de rateio das etapas acíclicas.</p><div class="tb"><button data-st-add>+ Etapa manual</button></div>'; panes.rot.querySelector('[data-st-add]').onclick = addStep; return; }
    if (pend.length || pendDist.length) {
      h += '<div class="warn" style="white-space:normal"><b>Preciso destes dados para o cálculo:</b>';
      pendDist.forEach(x => { h += `<div style="margin-top:8px" data-qd="${esc(x.qParam)}">Qual a distância percorrida em “${esc(x.text)}” (m)?<br><input data-qa placeholder="metros" style="width:120px;margin-top:4px"> <button data-qok>Responder</button></div>`; });
      pend.forEach(x => { const i = st.steps.indexOf(x);
        h += `<div style="margin-top:8px" data-q="${i}">${esc(stepQuestion(x, u))}${x.needsConfirm ? ' <span class="mut">(lido no texto: ' + esc(x.answer) + ' — confirme)</span>' : ''}<br>
        <input data-qa value="${esc(x.answer)}" placeholder="nº de ${esc(u)} ou fração (ex.: 6/420)" style="width:220px;margin-top:4px"> <button data-qok>${x.answer ? 'Confirmar' : 'Responder'}</button></div>`; });
      h += '</div>';
    }
    if (st.premises && st.premises.length) h += '<div class="mut" style="margin-bottom:6px"><b>Premissas lidas do texto:</b> ' + st.premises.map(esc).join(' · ') + '</div>';
    h += `<div class="tb"><button data-st-add>+ Etapa</button><button data-st-lines title="Preenche as linhas do vídeo em ordem (só as que ainda não têm descrição) e cria linhas para as etapas que sobrarem">Usar roteiro nas linhas</button><span class="mut">Marque "acíclica" quando a etapa não acontece em toda ${esc(u)}: o sistema pergunta quantas ${esc(plural(u))} cada ocorrência atende.</span></div>
    <table><thead><tr><th>#</th><th style="min-width:260px">Etapa</th><th>Código sugerido</th><th>Qtd.</th><th>Acíclica</th><th style="min-width:150px">Atende quantas ${esc(plural(u))}?</th><th>Frequência por ${esc(u)}</th><th style="min-width:200px">Origem do rateio</th><th>Linhas</th><th></th></tr></thead><tbody>`;
    st.steps.forEach((x, i) => {
      const f = stepFreq(x), nl = st.lines.filter(l => l.stepId === x.id).length;
      h += `<tr data-s="${i}" class="${x.acyclic && !f ? 'bad' : ''}"><td>${i + 1}</td>
        <td><input data-s-f="text" value="${esc(x.text)}"></td>
        <td><input data-s-f="code" list="mv-codes" value="${esc(x.code)}" style="width:90px" title="${esc(x.note || '')}"><div class="mut" style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(x.note || '')}">${esc(lib[x.code] ? lib[x.code].desc : x.code ? 'não está na biblioteca' : 'sem sugestão — escolha')}</div></td>
        <td><input data-s-f="q" value="${esc(x.q)}" style="width:56px"></td>
        <td style="text-align:center"><input type="checkbox" data-s-f="acyclic"${x.acyclic ? ' checked' : ''}></td>
        <td>${x.acyclic ? `<input data-s-f="answer" value="${esc(x.answer)}" placeholder="ex.: 5 ou 6/420">` : '<span class="mut">cíclica</span>'}</td>
        <td class="num">${x.acyclic ? (f ? esc(f) + ' = ' + CORE.num(f, 0).toFixed(4).replace('.', ',') : '<b style="color:#ffb4ac">pendente</b>') : esc(defaultF())}</td>
        <td class="mut">${x.acyclic ? esc(x.edited ? 'informado pelo usuário' : (x.source || 'informar')) : ''}</td>
        <td class="num">${nl}</td>
        <td><div class="acts"><button data-sa="up">↑</button><button data-sa="del">✕</button></div></td></tr>`;
    });
    h += '</tbody></table>';
    panes.rot.innerHTML = h;
    panes.rot.querySelector('[data-st-add]').onclick = addStep;
    panes.rot.querySelector('[data-st-lines]').onclick = useStepsInLines;
    panes.rot.querySelectorAll('[data-qd]').forEach(div => {
      const p = paramById(div.dataset.qd), inp = div.querySelector('[data-qa]');
      const ok = () => { const v = CORE.num(inp.value, NaN); if (!(v > 0)) { setStatus('Informe a distância em metros (número maior que zero).', true); return; }
        p.value = String(v); p.origin = 'Informado pelo usuário'; p.userEdited = true; st.steps.forEach(x => { if (x.qParam === p.id) x.q = String(v); }); syncParams(); renderAll(); };
      div.querySelector('[data-qok]').onclick = ok; inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
    });
    panes.rot.querySelectorAll('[data-q]').forEach(div => {
      const x = st.steps[+div.dataset.q], inp = div.querySelector('[data-qa]');
      const ok = () => { const v = inp.value.trim(); if (!v) return; if (v !== x.answer) { x.answer = v; x.edited = true; } x.confirmed = true;
        if (!stepFreq(x)) { setStatus('Resposta inválida: use um número maior que zero ou uma fração (ex.: 6/420).', true); return; }
        applyStep(x); renderAll(); };
      div.querySelector('[data-qok]').onclick = ok; inp.onkeydown = e => { if (e.key === 'Enter') ok(); };
    });
    const tb = panes.rot.querySelector('tbody');
    tb.addEventListener('change', e => {
      const el = e.target, tr = el.closest('tr[data-s]'); if (!tr || !el.dataset.sF) return;
      const x = st.steps[+tr.dataset.s], k = el.dataset.sF;
      if (k === 'acyclic') { x.acyclic = el.checked; if (!x.acyclic) { x.answer = ''; } }
      else if (k === 'answer') { x.answer = el.value.trim(); x.edited = true; x.confirmed = true; }
      else if (k === 'code') x.code = el.value.trim().toUpperCase();
      else if (k === 'text') { const old = x.text; x.text = el.value; st.lines.forEach(l => { if (l.stepId === x.id && l.desc === old) l.desc = x.text; }); }
      else x[k] = el.value;
      if (k === 'q' && x.qParam && paramById(x.qParam)) { const p = paramById(x.qParam); p.value = el.value; p.origin = 'Informado pelo usuário'; p.userEdited = true; }
      if (k === 'code') syncParams();
      applyStep(x); renderAll();
    });
    tb.addEventListener('click', e => {
      const b = e.target.closest('button[data-sa]'); if (!b) return;
      const i = +b.closest('tr').dataset.s;
      if (b.dataset.sa === 'up' && i > 0) st.steps.splice(i - 1, 0, st.steps.splice(i, 1)[0]);
      if (b.dataset.sa === 'del') { const x = st.steps[i]; st.lines.forEach(l => { if (l.stepId === x.id) l.stepId = ''; }); st.steps.splice(i, 1); }
      renderAll();
    });
  }
  function addStep() { st.steps.push({ id: 'st' + Date.now(), text: 'Nova etapa', code: '', note: '', q: '', acyclic: false, answer: '', source: '' }); renderAll(); showTab('rot'); }
  function useStepsInLines() {
    let k = 0;
    for (const l of st.lines) { if (k >= st.steps.length) break; if (String(l.desc || '').trim()) continue; linkLine(l, st.steps[k++]); }
    for (; k < st.steps.length; k++) { const l = { id: uid(), start: 0, end: 0, desc: '', agrega: '', code: '', q: '1', f: defaultF(), origin: 'Informado', simul: false, simulWith: '', etapa: '', dist: '', obs: 'sem minutagem — marcar no vídeo' }; linkLine(l, st.steps[k]); st.lines.push(l); }
    renderAll(); showTab('mov');
    setStatus('Roteiro aplicado. Confira se cada linha corresponde ao trecho do vídeo; ajuste a minutagem com ⇤ e ⇥ no ponto atual.');
  }

  /* ── Aba Movimentos ── */
  function renderLines() {
    const u = st.unit || '[unidade]';
    let h = `<div class="tb"><span class="mut">Frequência = ocorrências por <b>${esc(u)}</b> (aceita fração, ex.: 6/420). Quantidade = unidades às quais o TMU se aplica em uma ocorrência (ex.: metros no KA). PT só com justificativa.</span></div>
    <div class="tb">
      <label>Gerar linhas a partir de</label><select data-range>${rangeOptions()}</select>
      <button data-gen>Gerar linhas dos trechos detectados</button>
      <button data-add>+ Linha</button>
    </div>
    <table class="lines"><thead><tr><th>Nº</th><th>Minutagem (s)</th><th style="min-width:210px">Atividade / movimento observado</th><th>AGREGA</th><th style="min-width:90px">Código</th><th class="num">TMU</th><th>Qtd.</th><th>Freq.</th><th>Dist. (m)</th><th>Origem</th><th title="Executado ao mesmo tempo que outra linha; não soma no total">Simult.</th><th class="num">Total TMU</th><th class="num">Total (s)</th><th class="num">Vídeo (s)</th><th style="min-width:90px">Etapa</th><th style="min-width:220px">Descrição técnica / conteúdo</th><th style="min-width:130px">Evidência</th><th style="min-width:220px">Observação técnica / premissa</th><th></th></tr></thead><tbody>`;
    st.lines.forEach((l, i) => {
      const it = lib[l.code];
      h += `<tr data-i="${i}" class="${l.kind === 'pausa' ? 'low' : ''}">
        <td>${i + 1}</td>
        <td class="mm mut"><input data-f="start" value="${r2(l.start)}" style="width:58px" title="início (s) — ${mmss(l.start)}"> a <input data-f="end" value="${r2(l.end)}" style="width:58px" title="fim (s) — ${mmss(l.end)}"></td>
        <td><input data-f="desc" list="mv-hist" value="${esc(l.desc)}" placeholder="ex.: Apanhar 1 tampa da pilha com 2 mãos"></td>
        <td><select data-f="agrega" style="width:100px"><option value=""></option>${AGREGA_OPTS.map(o => `<option${o === l.agrega ? ' selected' : ''}>${o}</option>`).join('')}</select></td>
        <td><input data-f="code" list="mv-codes" value="${esc(l.code)}" title="${esc(it ? it.desc : 'código não encontrado na biblioteca')}"><div class="mut" data-o="cdesc" style="max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(it ? it.family + ' · ' + it.desc : (l.code ? 'não está na biblioteca' : ''))}</div></td>
        <td class="num" data-o="tmu"></td>
        <td><input data-f="q" value="${esc(l.q)}" style="width:56px"></td>
        <td><input data-f="f" value="${esc(l.f)}" style="width:66px"></td>
        <td><input data-f="dist" value="${esc(l.dist)}" style="width:50px"></td>
        <td><select data-f="origin" style="width:96px">${ORIGENS.map(o => `<option${o === l.origin ? ' selected' : ''}>${o}</option>`).join('')}</select></td>
        <td class="mm"><input type="checkbox" data-f="simul"${l.simul ? ' checked' : ''}> <input data-f="simulWith" value="${esc(l.simulWith)}" placeholder="Nº" style="width:40px"></td>
        <td class="num" data-o="ttmu"></td><td class="num" data-o="sec"></td>
        <td class="num">${fmtS(l.end - l.start)}</td>
        <td><input data-f="etapa" value="${esc(l.etapa)}" placeholder="ex.: Busca"></td><td><input data-f="tecnica" value="${esc(l.tecnica || '')}" placeholder="${esc(defaultTech(l.code))}" title="${esc(lineTech(l))}"></td><td><input data-f="evid" value="${esc(l.evid || '')}" placeholder="${esc(autoEvid(l, st.params))}"></td><td><input data-f="obs" value="${esc(l.obs)}" placeholder="observação / justificativa" title="${esc(l.obs)}"></td>
        <td><div class="acts"><button data-a="play" title="Ver trecho">▶</button><button data-a="s0" title="Início = ponto atual do vídeo">⇤</button><button data-a="s1" title="Fim = ponto atual do vídeo">⇥</button><button data-a="up" title="Subir">↑</button><button data-a="merge" title="Unir ao próximo">Unir</button><button data-a="dup" title="Duplicar">⧉</button><button data-a="del" title="Excluir">✕</button></div></td>
      </tr>`;
    });
    h += `</tbody><tfoot><tr class="tot"><td colspan="11">TOTAL DO PROCESSO POR ${esc(u.toUpperCase())}</td><td class="num" data-o="TT"></td><td class="num" data-o="TS"></td><td colspan="6"></td></tr></tfoot></table>`;
    if (!st.lines.length) h += `<p class="mut">Selecione o vídeo: os trechos detectados viram linhas para você descrever e codificar. Também é possível incluir linhas manualmente.</p>`;
    panes.mov.innerHTML = h;
    const tb = panes.mov.querySelector('tbody');
    tb.addEventListener('input', onLineInput); tb.addEventListener('change', onLineInput);
    tb.addEventListener('click', onLineAction);
    panes.mov.querySelector('[data-gen]').onclick = () => {
      if (!st.analysis) { setStatus('Leia um vídeo primeiro.', true); return; }
      if (st.lines.some(l => l.desc || l.code) && !confirm('Substituir as linhas atuais pelos trechos detectados?')) return;
      const v = panes.mov.querySelector('[data-range]').value;
      const ev = st.events.find(e => e.id === v);
      ev ? buildLines(ev.start, ev.end) : buildLines(0, st.duration);
      renderAll();
    };
    panes.mov.querySelector('[data-add]').onclick = () => { const t = r2(video.currentTime || 0); st.lines.push({ id: uid(), start: t, end: t, desc: '', agrega: '', code: '', q: '1', f: '1', origin: 'Observado', simul: false, simulWith: '', etapa: '', dist: '', obs: '' }); renderAll(); };
    renderLinesTotals();
  }
  function rangeOptions() {
    return `<option value="all">Vídeo inteiro</option>` + st.events.filter(e => e.type === 'Ciclo completo' && e.end > e.start).map((e, i) => `<option value="${e.id}">Ciclo ${i + 1} (${mmss(e.start)}–${mmss(e.end)})${e.use ? '' : ' · não confirmado'}</option>`).join('');
  }
  function onLineInput(e) {
    const el = e.target, tr = el.closest('tr[data-i]'); if (!tr || !el.dataset.f) return;
    const l = st.lines[+tr.dataset.i], k = el.dataset.f;
    if (k === 'simul') l.simul = el.checked;
    else if (k === 'start' || k === 'end') { const v = CORE.num(el.value, NaN); if (isFinite(v)) l[k] = v; }
    else l[k] = el.value;
    if (k === 'q') l.qParam = '';
    if (k === 'f') l.fParam = '';
    if (k === 'desc' && e.type === 'change') {
      const sp = st.steps.find(x => x.text === l.desc);
      if (sp) { linkLine(l, sp); renderLines(); renderRot(); renderSummary(); return; }
      if (l.stepId) { l.stepId = ''; }
    }
    if (k === 'desc' && e.type === 'change' && histMap.has(l.desc) && !l.code) {
      const h = histMap.get(l.desc); l.code = h.code; l.agrega = l.agrega || h.agrega || '';
      l.obs = (l.obs ? l.obs + '; ' : '') + 'código do histórico ("' + h.sheet + '") — conferir enquadramento';
      renderLines(); return;
    }
    if (k === 'code') { l.code = el.value.trim().toUpperCase(); const it = lib[l.code]; tr.querySelector('[data-o=cdesc]').textContent = it ? (it.family + ' · ' + it.desc) : (l.code ? 'não está na biblioteca' : ''); tr.querySelector('[data-f=tecnica]').placeholder = defaultTech(l.code);
      if (l.code === 'PT' && e.type === 'change' && (!l.q || l.q === '1') && l.end > l.start) { l.q = String(r2((l.end - l.start) / 60 * 10000) / 10000); tr.querySelector('[data-f=q]').value = l.q; l.obs = l.obs || 'PT: tempo medido no vídeo ' + fmtS(l.end - l.start) + ' s (' + mmss(l.start) + '–' + mmss(l.end) + '); justificar ausência de código aplicável'; tr.querySelector('[data-f=obs]').value = l.obs; } }
    updateRow(tr, l); renderLinesTotals(); renderSummary();
    if (k === 'start' || k === 'end') drawTimeline();
  }
  function updateRow(tr, l) {
    const c = lineCalc(l);
    tr.querySelector('[data-o=tmu]').textContent = isFinite(c.tmu) ? String(c.tmu).replace('.', ',') : '—';
    tr.querySelector('[data-o=ttmu]').textContent = c.valid ? c.ttmu.toFixed(2).replace('.', ',') : '—';
    tr.querySelector('[data-o=sec]').textContent = c.valid ? fmtS(c.sec) : '—';
    tr.classList.toggle('bad', !c.valid || !l.desc);
  }
  function renderLinesTotals() {
    panes.mov.querySelectorAll('tr[data-i]').forEach(tr => updateRow(tr, st.lines[+tr.dataset.i]));
    const t = totals(st);
    const TT = panes.mov.querySelector('[data-o=TT]'), TS = panes.mov.querySelector('[data-o=TS]');
    if (TT) { TT.textContent = t.tmu.toFixed(2).replace('.', ','); TS.textContent = fmtS(t.sec); }
    const totLabel = panes.mov.querySelector('tr.tot td'); if (totLabel) totLabel.textContent = 'TOTAL DO PROCESSO POR ' + (st.unit || '[UNIDADE]').toUpperCase();
  }
  function onLineAction(e) {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const i = +b.closest('tr').dataset.i, l = st.lines[i];
    if (b.dataset.a === 'play') return playRange(l.start, l.end);
    if (b.dataset.a === 's0') l.start = r2(video.currentTime || 0);
    if (b.dataset.a === 's1') l.end = r2(video.currentTime || 0);
    if (b.dataset.a === 'up' && i > 0) { st.lines.splice(i - 1, 0, st.lines.splice(i, 1)[0]); }
    if (b.dataset.a === 'merge' && st.lines[i + 1]) { const n = st.lines[i + 1]; l.end = Math.max(l.end, n.end); if (!l.desc) l.desc = n.desc; if (!l.code) l.code = n.code; st.lines.splice(i + 1, 1); }
    if (b.dataset.a === 'dup') st.lines.splice(i + 1, 0, Object.assign({}, l, { id: uid() }));
    if (b.dataset.a === 'del') { if ((l.desc || l.code) && !confirm('Excluir a linha ' + (i + 1) + '?')) return; st.lines.splice(i, 1); }
    renderAll();
  }

  /* ── Aba Cronoanálise ── */
  function renderCro() {
    const o = observed(st);
    let h = `<div class="tb"><button data-ev-add>+ Evento no ponto atual</button><span class="mut">Ciclos só entram na média quando "usar" estiver marcado. Pausas, interferências e atividades externas marcadas como "excluir" saem do tempo observado.</span></div>
    <label>Cobertura da filmagem</label><input data-cov value="${esc(st.coverage)}" style="width:100%;margin:3px 0 8px">
    <table><thead><tr><th>#</th><th>Tipo</th><th>Início (s)</th><th>Fim (s)</th><th class="num">Duração</th><th>Usar / excluir</th><th style="min-width:260px">Critério / motivo</th><th></th></tr></thead><tbody>`;
    st.events.forEach((e, i) => {
      const isCyc = e.type === 'Ciclo completo';
      h += `<tr data-e="${i}"><td>${i + 1}</td>
        <td><select data-g="type">${EVENT_TYPES.map(t => `<option${t === e.type ? ' selected' : ''}>${t}</option>`).join('')}</select></td>
        <td><input data-g="start" value="${r2(e.start)}" style="width:70px"><div class="mut">${mmss(e.start)}</div></td>
        <td><input data-g="end" value="${r2(e.end)}" style="width:70px"><div class="mut">${mmss(e.end)}</div></td>
        <td class="num">${fmtS(e.end - e.start)}</td>
        <td>${isCyc ? `<label><input type="checkbox" data-g="use"${e.use ? ' checked' : ''}> usar na média</label>` : e.type === 'Ciclo parcial' ? '<span class="mut">não entra na média</span>' : `<label><input type="checkbox" data-g="exclude"${e.exclude ? ' checked' : ''}> excluir do tempo</label>`}</td>
        <td><input data-g="reason" value="${esc(e.reason)}"></td>
        <td><div class="acts"><button data-ea="play">▶</button><button data-ea="del">✕</button></div></td></tr>`;
    });
    h += `</tbody></table>`;
    h += `<h4 style="margin:14px 0 4px">Resultado observado</h4><table><tbody>
      <tr><td>Tempo bruto filmado</td><td class="num">${fmtS(st.duration)} s</td></tr>
      ${o.per.map((p, i) => `<tr><td>Ciclo usado ${i + 1}: ${mmss(p.start)}–${mmss(p.end)}</td><td class="num">${fmtS(p.gross)} s bruto · ${fmtS(p.exc)} s excluído · ${fmtS(p.net)} s líquido</td></tr>`).join('')}
      <tr><td>Ciclos completos que sustentam a média</td><td class="num">${o.n}</td></tr>
      <tr><td>Média dos ciclos (líquido)</td><td class="num">${fmtS(o.meanNet)} s</td></tr>
      <tr><td>Unidades por ciclo</td><td class="num">${fmtS(o.upc)}</td></tr>
      <tr><td>Atividades acíclicas rateadas (duração × frequência)</td><td class="num">${fmtS(o.acycRateado)} s</td></tr>
      <tr><td><b>Tempo observado comparável por ${esc(st.unit || 'unidade')}</b></td><td class="num"><b>${fmtS(o.comparable)} s</b></td></tr>
    </tbody></table>`;
    if (!o.n) h += `<div class="warn">Nenhum ciclo completo confirmado. A comparação MTM × vídeo fica indisponível até você marcar início e fim de pelo menos um ciclo completo observado.</div>`;
    if (st.analysis) h += `<h4 style="margin:14px 0 4px">Trechos detectados pela leitura de movimento</h4><table><thead><tr><th>#</th><th>Início</th><th>Fim</th><th class="num">Duração</th><th>Leitura</th><th class="num">Intensidade</th></tr></thead><tbody>${st.analysis.segments.map((s, i) => `<tr><td>${i + 1}</td><td>${mmss(s.start)}</td><td>${mmss(s.end)}</td><td class="num">${fmtS(s.end - s.start)}</td><td>${s.kind === 'pausa' ? 'baixa movimentação — confirmar' : 'movimento'}${s.camera > .3 ? ' · câmera em movimento' : ''}</td><td class="num">${Math.round(s.intensity * 100)}%</td></tr>`).join('')}</tbody></table>`;
    panes.cro.innerHTML = h;
    panes.cro.querySelector('[data-cov]').oninput = e => { st.coverage = e.target.value; };
    panes.cro.querySelector('[data-ev-add]').onclick = () => { const t = r2(video.currentTime || 0); st.events.push({ id: uid(), type: 'Pausa', start: t, end: r2(Math.min(st.duration || t + 1, t + 1)), exclude: true, use: false, reason: '' }); renderAll(); };
    const tb = panes.cro.querySelector('tbody');
    const onEv = e => {
      const el = e.target, tr = el.closest('tr[data-e]'); if (!tr || !el.dataset.g) return;
      const ev = st.events[+tr.dataset.e], k = el.dataset.g;
      if (k === 'use' || k === 'exclude') ev[k] = el.checked;
      else if (k === 'start' || k === 'end') { const v = CORE.num(el.value, NaN); if (isFinite(v)) ev[k] = v; }
      else ev[k] = el.value;
      if (k === 'type') { ev.exclude = !!EXCLUDE_DEFAULT[ev.type]; if (ev.type !== 'Ciclo completo') ev.use = false; }
      if (e.type === 'change') { renderCro(); drawTimeline(); renderSummary(); panes.mov.querySelector('[data-range]') && (panes.mov.querySelector('[data-range]').innerHTML = rangeOptions()); }
    };
    tb.addEventListener('change', onEv); tb.addEventListener('input', e => { if (e.target.dataset.g === 'reason') onEv(e); });
    tb.addEventListener('click', e => {
      const b = e.target.closest('button[data-ea]'); if (!b) return;
      const i = +b.closest('tr').dataset.e;
      if (b.dataset.ea === 'play') playRange(st.events[i].start, st.events[i].end);
      if (b.dataset.ea === 'del') { st.events.splice(i, 1); renderAll(); }
    });
  }

  /* ── Aba Códigos e fontes ── */
  function usedCodes() { return [...new Set(st.lines.map(l => l.code).filter(Boolean))]; }
  function sourceOf(code) { return st.sources[code] || defaultSource(code, st.system === 'Logística' ? '' : st.system); }
  function renderCodes() {
    const codes = usedCodes();
    let h = `<p class="mut">Códigos e TMU vêm da biblioteca técnica do sistema (MATRIZ / LIB_CODES). As apostilas embutidas não têm marcação de página: a seção e a faixa de páginas são deduzidas pela família do código e ficam marcadas "conferir". Ajuste a fonte quando necessário.</p>
    <table><thead><tr><th>Sistema</th><th>Família</th><th>Código</th><th>Descrição</th><th class="num">TMU base</th><th>Unidade de aplicação</th><th style="min-width:320px">Documento e página / tabela</th></tr></thead><tbody>`;
    codes.forEach(c => {
      const it = lib[c];
      h += it ? `<tr><td>${esc(systemOf(c))}</td><td>${esc(it.family)}</td><td><b>${esc(c)}</b></td><td>${esc(it.desc)}${it.conflict != null ? `<div class="mut">Atenção: LIB_CODES traz ${it.conflict} TMU; usado o valor da MATRIZ.</div>` : ''}</td><td class="num">${String(it.tmu).replace('.', ',')}</td><td>${esc(it.unit)}</td><td><input data-src="${esc(c)}" value="${esc(sourceOf(c))}" style="width:100%"></td></tr>`
        : `<tr class="bad"><td colspan="7"><b>${esc(c)}</b> não existe na biblioteca técnica — escolha um código válido.</td></tr>`;
    });
    h += '</tbody></table>';
    if (!codes.length) h += '<p class="mut">Nenhum código usado ainda.</p>';
    panes.cod.innerHTML = h;
    panes.cod.querySelectorAll('[data-src]').forEach(el => el.oninput = () => { st.sources[el.dataset.src] = el.value; });
  }


  /* ── Aba Premissas (alimenta Q e F por fórmula no Excel) ── */
  function renderPre() {
    const u = st.unit || 'unidade';
    let h = `<p class="mut">Os valores em amarelo vão para a aba Premissas do Excel. As linhas ligadas a um parâmetro usam fórmula (Q = Premissas!B…, F = 1/Premissas!B…): ao mudar o valor aqui ou na planilha, o cálculo acompanha.</p>
    <div class="tb"><button data-p-add>+ Parâmetro</button></div>
    <table><thead><tr><th style="min-width:300px">Parâmetro</th><th>Valor</th><th>Unidade</th><th style="min-width:300px">Origem / critério</th><th class="num">Linhas ligadas</th><th></th></tr></thead><tbody>
    <tr><td>Unidade de referência do relatório</td><td>${esc(u)}</td><td>-</td><td class="mut">Pergunta obrigatória</td><td></td><td></td></tr>
    <tr><td>Unidades por ciclo observado</td><td>${esc(st.unitsPerCycle)}</td><td>${esc(plural(u))}</td><td class="mut">Informado</td><td></td><td></td></tr>`;
    st.params.forEach((p, i) => {
      const nl = st.lines.filter(l => l.qParam === p.id || l.fParam === p.id).length;
      h += `<tr data-p="${i}"><td><input data-pf="name" value="${esc(p.name)}"></td><td><input data-pf="value" value="${esc(p.value)}" style="width:80px;background:#3a3410"></td><td><input data-pf="unit" value="${esc(p.unit)}" style="width:70px"></td><td><input data-pf="origin" value="${esc(p.origin)}"></td><td class="num">${nl}</td><td><button data-p-del>✕</button></td></tr>`;
    });
    h += `<tr><td>TMU para segundo</td><td>0,036</td><td>s/TMU</td><td class="mut">Conversão padrão MTM</td><td></td><td></td></tr></tbody></table>`;
    const P = pendencias(st);
    h += `<h4 style="margin:14px 0 4px">Atenção (gerado pela análise)</h4><table><thead><tr><th>Ponto</th><th>Status</th><th>Efeito</th><th>Como resolver</th></tr></thead><tbody>${P.length ? P.map(x => `<tr>${x.map(v => `<td>${esc(v)}</td>`).join('')}</tr>`).join('') : '<tr><td colspan="4" class="mut">Nenhuma pendência.</td></tr>'}</tbody></table>`;
    panes.pre.innerHTML = h;
    panes.pre.querySelector('[data-p-add]').onclick = () => { st.params.push({ id: 'pu_' + Date.now(), name: 'Novo parâmetro', value: '', unit: '', origin: 'Informado pelo usuário' }); renderPre(); };
    const tb = panes.pre.querySelector('tbody');
    tb.addEventListener('change', e => {
      const tr = e.target.closest('tr[data-p]'); if (!tr || !e.target.dataset.pf) return;
      const p = st.params[+tr.dataset.p], k = e.target.dataset.pf; p[k] = e.target.value;
      if (k === 'value') {
        p.userEdited = true; if (!/usu[aá]rio/i.test(p.origin)) p.origin = 'Informado pelo usuário';
        if (/^pf_/.test(p.id)) { const root = st.steps.find(x => 'pf_' + x.id === p.id); if (root) { root.answer = p.value; root.edited = true; root.confirmed = true; st.steps.filter(o => o.groupOf === root.id).forEach(o => { o.answer = p.value; o.confirmed = true; }); } }
        if (/^pq_/.test(p.id)) st.steps.forEach(x => { if (x.qParam === p.id) x.q = p.value; });
        st.lines.forEach(l => { if (l.qParam === p.id) l.q = p.value; });
        st.steps.forEach(x => applyStep(x));
        renderAll(); return;
      }
    });
    tb.addEventListener('click', e => { const b = e.target.closest('[data-p-del]'); if (!b) return; const p = st.params[+b.closest('tr').dataset.p]; st.lines.forEach(l => { if (l.qParam === p.id) l.qParam = ''; if (l.fParam === p.id) l.fParam = ''; }); st.params.splice(st.params.indexOf(p), 1); renderAll(); });
  }

  /* ── Aba Melhorias (padrão: ponto / proposta / impacto / prioridade) ── */
  function renderMel() {
    let h = `<div class="tb"><button data-m-add>+ Ponto</button><button data-m-auto>Sugerir pontos a partir da análise</button><span class="mut">Registre só o que o vídeo sustenta. Ganho estimado fica fora do tempo do método atual.</span></div>
    <table><thead><tr><th>Nº mov.</th><th style="min-width:240px">Ponto observado / risco</th><th style="min-width:240px">Proposta / validação</th><th style="min-width:200px">Impacto no MTM</th><th>Prioridade</th><th>Evidência</th><th>Ganho est. (s)</th><th></th></tr></thead><tbody>`;
    st.improvements.forEach((m, i) => {
      h += `<tr data-m="${i}"><td><input data-h="ref" value="${esc(m.ref)}" style="width:54px"></td><td><input data-h="ponto" value="${esc(m.ponto || m.text || '')}"></td><td><input data-h="proposta" value="${esc(m.proposta || '')}"></td><td><input data-h="impacto" value="${esc(m.impacto || '')}"></td>
      <td><select data-h="prioridade">${['', 'Alta', 'Média', 'Baixa'].map(o => `<option${o === (m.prioridade || '') ? ' selected' : ''}>${o}</option>`).join('')}</select></td><td><input data-h="evid" value="${esc(m.evid)}" style="width:90px"></td><td><input data-h="gain" value="${esc(m.gain)}" style="width:60px"></td><td><button data-m-del>✕</button></td></tr>`;
    });
    h += '</tbody></table>';
    panes.mel.innerHTML = h;
    panes.mel.querySelector('[data-m-add]').onclick = () => { const cur = st.lines.findIndex(l => video.currentTime >= l.start && video.currentTime < l.end); st.improvements.push({ ref: cur >= 0 ? String(cur + 1) : '', ponto: '', proposta: '', impacto: '', prioridade: '', evid: mmss(video.currentTime || 0), gain: '' }); renderMel(); };
    panes.mel.querySelector('[data-m-auto]').onclick = () => {
      const have = new Set(st.improvements.map(m => m.ponto));
      const add = m => { if (!have.has(m.ponto)) { st.improvements.push(Object.assign({ ref: '', evid: '', gain: '' }, m)); have.add(m.ponto); } };
      st.lines.forEach((l, i) => {
        const it = lib[l.code] || {};
        if (it.unit === 'metro' && CORE.num(l.q, 0) >= 3) add({ ref: String(i + 1), ponto: 'Deslocamento de ' + l.q + ' m em “' + l.desc + '”' + (isAcyclic(l) ? ' (rateado ' + l.f + ')' : ' a cada ' + (st.unit || 'unidade')), proposta: 'Aproximar o ponto de abastecimento ou aumentar o lote por viagem', impacto: 'Reduz ' + l.code + ' (' + it.tmu + ' TMU/m)', prioridade: 'Média' });
        if (/^B[AB]\d$/.test(l.code) && CORE.num(l.q, 1) > 2) add({ ref: String(i + 1), ponto: l.q + ' pressões para encaixar em “' + l.desc + '”', proposta: 'Verificar tolerância de encaixe e estado das tampas/caixas', impacto: 'Reduz Q do acionamento', prioridade: 'Média' });
        if (l.kind === 'pausa') add({ ref: String(i + 1), ponto: 'Trecho de baixa movimentação em “' + (l.desc || 'linha ' + (i + 1)) + '”', proposta: 'Confirmar se é espera, procura ou movimento fino; eliminar causa de espera', impacto: 'Pode alterar código ou gerar PT justificado', prioridade: 'Média', evid: mmss(l.start) + '–' + mmss(l.end) });
      });
      pendencias(st).forEach(x => add({ ponto: x[0] + ': ' + x[2], proposta: x[3], impacto: 'Pode alterar código, Q ou F', prioridade: x[1] === 'Pendente' ? 'Alta' : 'Média' }));
      renderMel();
    };
    panes.mel.querySelector('tbody').addEventListener('input', e => { const tr = e.target.closest('tr[data-m]'); if (tr && e.target.dataset.h) st.improvements[+tr.dataset.m][e.target.dataset.h] = e.target.value; });
    panes.mel.querySelector('tbody').addEventListener('change', e => { const tr = e.target.closest('tr[data-m]'); if (tr && e.target.dataset.h) st.improvements[+tr.dataset.m][e.target.dataset.h] = e.target.value; });
    panes.mel.querySelector('tbody').addEventListener('click', e => { if (e.target.closest('[data-m-del]')) { st.improvements.splice(+e.target.closest('tr').dataset.m, 1); renderMel(); } });
  }

  /* ── Resumo e conferência ── */
  function renderSummary() {
    const t = totals(st), o = observed(st);
    const diff = o.comparable != null ? t.sec - o.comparable : null;
    const pct = o.comparable ? diff / o.comparable * 100 : null;
    const u = st.unit || 'unidade';
    $('.sum').innerHTML = `
      <div><span>TMU total por ${esc(u)}</span><b>${t.tmu.toFixed(2).replace('.', ',')}</b></div>
      <div><span>Segundos calculados (MTM)</span><b>${fmtS(t.sec)}</b></div>
      <div><span>Segundos observados comparáveis</span><b>${fmtS(o.comparable)}</b></div>
      <div><span>Ciclos completos observados</span><b>${o.n}</b></div>
      <div><span>Diferença (s)</span><b>${diff == null ? '—' : (diff > 0 ? '+' : '') + fmtS(diff)}</b></div>
      <div><span>Diferença (%)</span><b>${pct == null ? '—' : (pct > 0 ? '+' : '') + pct.toFixed(1).replace('.', ',') + '%'}</b></div>`;
  }
  function problems() {
    const p = [];
    if (!String(st.unit).trim()) p.push('Responda: QUAL SERÁ A UNIDADE DE REFERÊNCIA DESTA ANÁLISE?');
    if (!isFinite(CORE.num(st.unitsPerCycle, NaN)) || CORE.num(st.unitsPerCycle, 0) <= 0) p.push('Unidades por ciclo deve ser um número maior que zero.');
    if (!st.lines.length) p.push('Nenhuma linha de movimento.');
    st.lines.forEach((l, i) => {
      const n = 'Linha ' + (i + 1) + ': ';
      if (!String(l.desc).trim()) p.push(n + 'descreva a atividade observada.');
      if (!l.code) p.push(n + 'informe o código MTM.');
      else if (!lib[l.code]) p.push(n + 'o código ' + l.code + ' não existe na biblioteca.');
      if (!(CORE.num(l.q, NaN) > 0)) p.push(n + 'quantidade inválida.');
      if (!(CORE.num(l.f, NaN) >= 0)) p.push(n + 'frequência inválida.');
      if (l.code === 'PT' && String(l.obs || '').replace(/Rateio:[^;]*(;\s*)?/g, '').trim().length < 15) p.push(n + 'PT exige justificativa e como o tempo foi medido.');
      if (l.simul && !String(l.simulWith).trim()) p.push(n + 'indique com qual Nº a linha é simultânea.');
      if (!(l.end >= l.start)) p.push(n + 'fim antes do início.');
      else if (st.duration && !(l.end > l.start)) p.push(n + 'marque a minutagem no vídeo (⇤ início, ⇥ fim).');
    });
    st.steps.forEach((x, i) => {
      if (!x.acyclic || !st.lines.some(l => l.stepId === x.id)) return;
      if (!stepFreq(x)) p.push('Rateio pendente (roteiro ' + (i + 1) + '): ' + stepQuestion(x, st.unit || 'unidade'));
      else if (x.needsConfirm && !x.confirmed) p.push('Confirme o rateio deduzido do texto (roteiro ' + (i + 1) + '): ' + x.text);
    });
    st.params.forEach(pp => { if ((st.lines.some(l => l.qParam === pp.id || l.fParam === pp.id)) && !(CORE.num(pp.value, NaN) > 0)) p.push('Premissa sem valor: ' + pp.name + '.'); });
    usedCodes().forEach(c => { if (lib[c] && !String(sourceOf(c)).trim()) p.push('Código ' + c + ': informe a fonte.'); });
    st.events.forEach((e, i) => { if (e.end < e.start) p.push('Evento ' + (i + 1) + ': fim antes do início.'); if ((e.exclude || e.use) && !String(e.reason).trim()) p.push('Evento ' + (i + 1) + ': informe o motivo/critério.'); });
    return p;
  }
  function showCheck(p, okMsg) {
    $('.check').innerHTML = p.length ? `<div class="warn">Antes de liberar, corrija:\n• ${p.slice(0, 14).map(esc).join('\n• ')}${p.length > 14 ? '\n… e mais ' + (p.length - 14) : ''}</div>` : (okMsg ? `<div class="ok">${okMsg}</div>` : '');
  }

  function renderAll() { renderRot(); renderPre(); fillDescList(); renderLines(); renderCro(); renderCodes(); renderMel(); renderSummary(); drawTimeline(); }

  /* ── Gravar na folha do projeto ── */
  $('[data-save]').onclick = () => {
    const p = problems(); if (p.length) { showCheck(p); return; }
    if (!sameProject()) { showCheck(['Abra novamente o projeto de origem (' + project.name + ').']); return; }
    const existing = savedSheetId && sheets.find(s => s.id === savedSheetId);
    const id = existing ? existing.id : gid();
    const rows = st.lines.map((l, i) => {
      const c = lineCalc(l);
      return { id: 'r_' + id + '_' + i, desc: l.desc + (l.simul ? ' (simultâneo ao Nº ' + l.simulWith + ' — não soma)' : ''), agrega: l.agrega, code: l.code,
        tmu: String(c.tmu), q: String(c.q), f: String(c.fEff), ttmu: +c.ttmu.toFixed(4), tsec: +c.sec.toFixed(4) };
    });
    const vm = JSON.parse(JSON.stringify(Object.assign({}, st, { analysis: null, samples: undefined })));
    vm.segments = st.lines.map((l, i) => ({ rowId: rows[i].id, start: l.start, end: l.end, features: l.features || null }));
    vm.savedAt = new Date().toISOString();
    const header = Object.assign({}, existing ? existing.header : {}, { empresa: pmData[folderId].name, projeto: project.name, processo: st.process || ('Análise por vídeo — ' + st.filename), pcsCiclo: '1', pcsCicloUnit: st.unit, videoMtm: vm });
    if (existing) { existing.rows = rows; existing.header = header; }
    else { sheets.push({ id, label: 'Vídeo ' + (st.process || st.filename).slice(0, 40), rows, header, book: '', fadiga: null }); attachSheetToActiveProject(id); }
    savedSheetId = id;
    try { if (typeof recalcSheet === 'function') recalcSheet(id); } catch (e) { }
    saveSheets(); renderTabs(); setActive(id);
    try { if (typeof renderContent === 'function') renderContent(id); } catch (e) { }
    const t = totals(st), sheetTot = rows.reduce((s, r) => s + r.ttmu, 0);
    showCheck([], 'Gravado na folha "' + sheets.find(s => s.id === id).label + '". TMU da folha ' + sheetTot.toFixed(2) + ' = TMU do resumo ' + t.tmu.toFixed(2) + '.');
  };

  /* ── Exportar Excel ── */
  $('[data-xlsx]').onclick = async () => {
    const p = problems(); if (p.length) { showCheck(p); return; }
    try {
      setStatus('Montando a planilha…');
      const X = await loadStyledXlsx();
      const { wb, check } = buildWorkbook(X, st, { folder: pmData[folderId].name, project: project.name, observed: observed(st), totals: totals(st), sourceOf });
      const safe = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
      const fname = 'Analise_MTM_' + (safe(st.process) || safe(st.filename.replace(/\.[^.]+$/, '')) || 'video') + '_por_' + (safe(st.unit) || 'unidade') + '.xlsx';
      X.writeFile(wb, fname, { compression: true });
      setStatus('Planilha gerada: ' + fname);
      showCheck([], 'Conferência: ' + check.join(' · '));
    } catch (err) { setStatus('Falha ao gerar o Excel: ' + (err && err.message || err), true); }
  };

  renderAll();
  dlg.showModal();
  setStatus('Responda a unidade de referência e selecione o vídeo. A leitura começa enquanto você preenche.');
}

/* ── Biblioteca Excel com estilos, carregada da pasta do sistema ── */
let styledXlsx = null;
function loadStyledXlsx() {
  if (styledXlsx) return Promise.resolve(styledXlsx);
  return new Promise((resolve, reject) => {
    const prev = window.XLSX;
    const s = document.createElement('script');
    s.src = SCRIPT_BASE + 'xlsx-style.min.js';
    s.onload = () => {
      styledXlsx = window.XLSX;
      if (prev) window.XLSX = prev; // mantém a biblioteca original do sistema
      if (!styledXlsx || !styledXlsx.utils) return reject(new Error('xlsx-style.min.js inválido.'));
      resolve(styledXlsx);
    };
    s.onerror = () => reject(new Error('Arquivo xlsx-style.min.js não encontrado na pasta do sistema (ele permite gerar o Excel sem internet).'));
    document.head.append(s);
  });
}


/* ── Notas técnicas padrão por código (o que o código cobre / o que não somar) ── */
function codeNote(code) {
  const it = library()[code] || {};
  if (code === 'PT') return 'Tempo medido (1666,67 TMU = 60 s); Q = minutos. Usar só sem código aplicável, com justificativa.';
  if (/^SAD/.test(code)) return 'Inclui apanhar e posicionar a tampa/cobertura; não somar AC/PA para a mesma tampa.';
  if (/^PAD/.test(code)) return 'Inclui apanhar e depor a tampa/cobertura retirada; não somar AC para a mesma peça.';
  if (/^HA[MO]/.test(code)) return 'Inserir garfos, bombear, retirar e orientar incluídos no módulo; não somar HRZ junto com HAM.';
  if (/^HFV/.test(code)) return 'Apanhar a alça e partida/parada incluídos; não somar EH para a alça.';
  if (/^HFK/.test(code)) return 'Contar só curvas de 90° fora do módulo de apanhar.';
  if (it.unit === 'metro') return 'Por metro: Q = metros; não aplicar outro código de deslocamento aos mesmos metros.';
  if (/^A[A-Z]\d$/.test(code)) return 'Apanhar e colocar no mesmo código; não somar PA/PC para a mesma colocação.';
  if (/^P[ABC]\d$/.test(code)) return 'Colocar no lugar com objeto já dominado; somente colocação/ajuste distinto.';
  if (/^B[AB]\d$/.test(code)) return 'Acionamento; Q = nº de acionamentos/pressões observados.';
  if (code === 'KB') return 'Movimento completo: curvar e voltar à postura normal.';
  if (code === 'EH') return 'Apanhar e depor meio auxiliar; não somar quando o módulo já inclui a pega.';
  return '';
}
function defaultTech(code) {
  const it = library()[code]; if (!it) return '';
  const n = codeNote(code);
  return it.desc + (n ? '. ' + n : '');
}
function autoEvid(l, params) {
  if (l.end > l.start) return 'Filmado ~' + String(r2(l.start)).replace('.', ',') + '–' + String(r2(l.end)).replace('.', ',') + ' s';
  const p = params && l.qParam && params.find(x => x.id === l.qParam);
  if (l.origin === 'Informado') return 'Informado' + (p && p.value !== '' ? ': ' + p.value + ' ' + (p.unit || '') : '');
  if (l.origin === 'Estimado') return 'Estimado / premissa';
  return 'Não filmado — confirmar';
}
const lineFamily = l => l.familia || ((library()[l.code] || {}).family) || '';
const lineTech = l => (l.tecnica && l.tecnica.trim()) || defaultTech(l.code);
const lineEvid = (l, params) => (l.evid && l.evid.trim()) || autoEvid(l, params);

/* Pendências (ATENÇÃO) geradas a partir do estado */
function pendencias(st) {
  const P = [];
  const u = st.unit || 'unidade';
  (st.steps || []).forEach(x => { if (x.acyclic && x.needsConfirm && !x.confirmed) P.push(['Rateio de “' + x.text + '”', 'Pendente', 'Frequência ' + (stepFreq(x) || '?') + ' por ' + u + ' deduzida do texto', 'Confirmar quantas ' + plural(u) + ' cada ocorrência atende']); });
  (st.params || []).forEach(p => { if (p.origin && /estimad/i.test(p.origin)) P.push([p.name, 'Estimado', 'Valor ' + p.value + ' ' + (p.unit || '') + ' usado no cálculo', 'Medir em campo e alterar o valor na aba Premissas']); });
  const seen = new Set();
  st.lines.forEach(l => {
    if (!l.code || seen.has(l.code)) return;
    if (/^SAD|^PAD/.test(l.code)) { seen.add(l.code); P.push(['Dimensão da tampa/cobertura (' + l.code + ')', 'Pendente', 'Faixa A/B/C depende da maior dimensão (≤30 / ≤50 / ≤80 cm)', 'Medir e confirmar o código']); }
    if (/^A[A-Z]\d$|^AL|^AK|^AH/.test(l.code)) { seen.add(l.code); P.push(['Peso, pega e distância (' + l.code + ')', 'Conferir', 'Classe do apanhar depende do peso (≤1 / ≤8 / ≤22 daN) e da faixa de alcance', 'Pesar o objeto e confirmar a faixa no vídeo']); }
    if (/^HA[MO]/.test(l.code)) { seen.add(l.code); P.push(['Geometria para apanhar com paleteira (' + l.code + ')', 'Pendente', 'HAM (com acertar) e HAO (sem acertar) são alternativas; não acumular', 'Confirmar se é necessário acertar antes da inserção']); }
  });
  if (st.lines.some(l => l.origin === 'Estimado')) P.push(['Linhas estimadas', 'Conferir', st.lines.filter(l => l.origin === 'Estimado').length + ' linha(s) com origem Estimado', 'Confirmar no vídeo ou com o processo']);
  if (st.lines.some(l => l.kind === 'pausa')) P.push(['Trechos de baixa movimentação', 'Conferir', 'Podem ser espera, pausa ou movimento fino', 'Assistir ao trecho e classificar']);
  const ob = observed(st);
  if (!ob.n) P.push(['Ciclo completo observado', 'Pendente', 'Sem ciclo completo confirmado, a comparação por ' + u + ' fica limitada ao trecho filmado', 'Marcar início e fim de um ciclo completo ou filmar o ciclo inteiro']);
  return P;
}

/* ── Montagem da planilha no padrão REV03 (Upload + Análise Completa + Premissas + Cronoanálise + Confronto + Biblioteca + Melhorias) ── */
function buildWorkbook(X, st, ctx) {
  CUR_UPC = Math.max(1e-9, CORE.num(st.unitsPerCycle, 1));
  const NAVY = '102B4F', TOT = '16365A', TXT = '1D2B39', SUBT = '536679', SUBF = 'E6F0FA', CALC = 'E9F5EE', EDIT = 'FFF2CF', ZEB = 'F2F6FA', FONT = 'Poppins';
  const base = { name: FONT, sz: 10, color: { rgb: TXT } };
  const S = {
    title: { font: { name: FONT, sz: 15, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: NAVY } }, alignment: { vertical: 'center' } },
    sub: { font: { name: FONT, sz: 10, color: { rgb: SUBT } }, fill: { fgColor: { rgb: SUBF } }, alignment: { wrapText: true, vertical: 'center' } },
    th: { font: { name: FONT, sz: 10, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: NAVY } }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } },
    td: { font: base, alignment: { wrapText: true, vertical: 'center' } },
    calc: { font: base, fill: { fgColor: { rgb: CALC } }, alignment: { wrapText: true, vertical: 'center' } },
    edit: { font: base, fill: { fgColor: { rgb: EDIT } }, alignment: { wrapText: true, vertical: 'center' } },
    zeb: { font: base, fill: { fgColor: { rgb: ZEB } }, alignment: { wrapText: true, vertical: 'center' } },
    tot: { font: { name: FONT, sz: 11, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: TOT } }, alignment: { vertical: 'center' } },
    totU: { font: { name: FONT, sz: 10, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: TOT } }, alignment: { vertical: 'center' } },
    sec: { font: { name: FONT, sz: 11, bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: TOT } }, alignment: { vertical: 'center' } },
  };
  const wb = X.utils.book_new();
  const U = String(st.unit || 'unidade'), UP = U.toUpperCase();
  const pend = pendencias(st);
  const prelim = pend.length > 0;
  const params = (st.params || []).filter(p => p && p.name);

  function sheet(name, build, cols, opt) {
    opt = opt || {};
    const ws = {}, merges = [], rows = []; let maxR = 0, maxC = 0;
    const off = opt.aux ? 1 : 0, XR = r => r + 1 + off;
    const put = (r, c, v, style, fmt) => {
      r += off;
      let cell;
      if (v && typeof v === 'object' && 'f' in v) cell = (typeof v.v === 'string') ? { t: 's', f: v.f, v: v.v } : { t: 'n', f: v.f, v: isFinite(v.v) ? v.v : 0 };
      else if (typeof v === 'number') cell = { t: 'n', v: isFinite(v) ? v : 0 };
      else cell = { t: 's', v: v == null ? '' : String(v) };
      cell.s = Object.assign({}, style || S.td, fmt ? { numFmt: fmt } : {});
      ws[X.utils.encode_cell({ r, c })] = cell; maxR = Math.max(maxR, r); maxC = Math.max(maxC, c);
    };
    const merge = (r0, c0, r1, c1, style) => { r0 += off; r1 += off; merges.push({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } }); if (style) for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const a = X.utils.encode_cell({ r, c }); if (!ws[a]) ws[a] = { t: 's', v: '', s: style }; } };
    const height = (r, h) => { rows[r + off] = { hpt: h }; };
    if (opt.aux) { ws.A1 = { t: 's', v: 'MTM_RESUMO_V1', s: { font: { name: FONT, sz: 6, color: { rgb: 'FFFFFF' } } } }; rows[0] = { hidden: true, hpt: 2 }; }
    build(put, merge, XR, height);
    ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
    ws['!merges'] = merges; ws['!cols'] = cols.map(w => ({ wch: w }));
    for (let r = 0; r <= maxR; r++) if (!rows[r]) rows[r] = { hpt: 30 };
    ws['!rows'] = rows;
    if (opt.freeze) ws['!freeze'] = opt.freeze;
    X.utils.book_append_sheet(wb, ws, name);
  }
  const L = st.lines.map((l, i) => Object.assign({ n: i + 1 }, l, { c: lineCalc(l) }));
  const fracExpr = v => /\//.test(String(v)) ? String(v).replace(',', '.').replace(/\s/g, '') : null;

  /* Premissas: posição de cada parâmetro (linha Excel) */
  const pRow = {}; // id -> excel row
  const PR0 = 4; // 0-based row of first param (after hidden marker: XR handles)
  const allParams = [
    { id: '_unit', name: 'Unidade de referência do relatório', value: U + (st.unitRef ? ' (' + st.unitRef + ')' : ''), unit: '-', origin: 'Informado pelo usuário (pergunta obrigatória)' },
    { id: '_upc', name: 'Unidades por ciclo observado', value: CORE.num(st.unitsPerCycle, 1), unit: plural(U), origin: 'Informado pelo usuário' },
    ...params,
    { id: '_tmu', name: 'TMU para segundo', value: 0.036, unit: 's/TMU', origin: 'Conversão padrão MTM' },
  ];
  allParams.forEach((p, i) => { pRow[p.id] = PR0 + i + 2; }); // +1 marker row, +1 1-based
  const TMU_S = 'Premissas!$B$' + pRow._tmu;
  const pVal = id => { const p = allParams.find(x => x.id === id); return p ? CORE.num(p.value, NaN) : NaN; };

  /* 1) MTM Upload — ligado à Análise Completa */
  const AC0 = 4; // 0-based linha da 1ª atividade na Análise Completa (antes do marcador)
  const acRow = i => AC0 + i + 2; // linha Excel na Análise Completa (marcador oculto + 1-based)
  const acTot = acRow(L.length);
  sheet('MTM Upload', (put, merge, XR, height) => {
    ['Nº', 'DESCRIÇÃO', 'AGREGA', 'CÓDIGO', 'TMU', 'Q', 'F', 'TOTAL TMU', 'TOTAL (S)'].forEach((h, c) => put(0, c, h, S.th));
    height(0, 39);
    const ref = (col, r) => `'Analise Completa'!${col}${r}`;
    L.forEach((l, i) => {
      const r = i + 1, R = acRow(i);
      put(r, 0, { f: ref('A', R), v: l.n }, S.td);
      put(r, 1, { f: ref('C', R), v: l.desc + (l.simul ? ' (simultâneo ao Nº ' + l.simulWith + ' — não soma)' : '') }, S.td);
      put(r, 2, { f: ref('D', R), v: l.agrega || '' }, S.td);
      put(r, 3, { f: ref('F', R), v: l.code }, S.td);
      put(r, 4, { f: ref('H', R), v: l.c.tmu }, S.td, '0.00');
      put(r, 5, { f: ref('I', R), v: l.c.q }, S.td, '0.00');
      put(r, 6, { f: ref('K', R), v: l.c.fEff }, S.td, '0.0000');
      put(r, 7, { f: ref('L', R), v: l.c.ttmu }, S.calc, '0.00');
      put(r, 8, { f: ref('M', R), v: l.c.sec }, S.calc, '0.00');
      height(r, 39);
    });
    const t = L.length + 1;
    put(t, 0, 'TOTAL DO PROCESSO POR ' + UP + (prelim ? ' - CENÁRIO PRELIMINAR' : ''), S.totU); merge(t, 0, t, 6, S.totU);
    put(t, 7, { f: `'Analise Completa'!L${acTot}`, v: ctx.totals.tmu }, S.totU, '0.00');
    put(t, 8, { f: `'Analise Completa'!M${acTot}`, v: ctx.totals.sec }, S.totU, '0.00');
    height(t, 39);
  }, [7, 100, 19, 17, 14, 13, 11, 19, 14], { freeze: { xSplit: 0, ySplit: 1 } });

  /* 2) Análise Completa */
  sheet('Analise Completa', (put, merge, XR, height) => {
    put(0, 0, 'MTM  |  ' + String(st.process || 'ANÁLISE POR VÍDEO').toUpperCase(), S.title); merge(0, 0, 0, 14, S.title); height(0, 38);
    const resumo = (prelim ? 'Análise preliminar: ' : 'Análise concluída: ') + 'sequência observada no vídeo ' + (st.filename || '') + '; resultado por ' + U + '. '
      + (prelim ? pend.length + ' ponto(s) a confirmar na aba Premissas.' : 'Sem pendências registradas.');
    put(1, 0, resumo, S.sub); merge(1, 0, 1, 14, S.sub); height(1, 29);
    ['Nº', 'Etapa', 'Movimento / atividade', 'AGREGA', 'Família MTM', 'Código MTM', 'Descrição técnica / conteúdo', 'TMU base', 'Q', 'Distância (m)', 'F', 'Total TMU', 'Total (s)', 'Evidência', 'Observação técnica / premissa'].forEach((h, c) => put(3, c, h, S.th));
    height(3, 38);
    L.forEach((l, i) => {
      const r = AC0 + i, R = XR(r), it = library()[l.code] || {};
      put(r, 0, l.n); put(r, 1, l.etapa || ''); put(r, 2, l.desc + (l.simul ? ' (simultâneo ao Nº ' + l.simulWith + ' — não soma)' : ''));
      put(r, 3, l.agrega || ''); put(r, 4, lineFamily(l)); put(r, 5, l.code); put(r, 6, lineTech(l));
      put(r, 7, l.c.tmu);
      // Q: ligado à premissa quando houver
      if (l.qParam && pRow[l.qParam] && isFinite(pVal(l.qParam))) put(r, 8, { f: 'Premissas!B' + pRow[l.qParam], v: l.c.q }, S.td, '0.00');
      else put(r, 8, fracExpr(l.q) ? { f: fracExpr(l.q), v: l.c.q } : l.c.q, S.td, '0.00');
      // Distância: igual a Q nos códigos por metro; senão o valor informado
      if (it.unit === 'metro') put(r, 9, { f: 'I' + R, v: l.c.q }, S.td, '0.00');
      else put(r, 9, l.dist === '' || l.dist == null ? '' : CORE.num(l.dist, 0), S.td, '0.00');
      // F: 0 se simultâneo; 1/premissa quando o rateio vem de um parâmetro; fração literal; ou número
      if (l.simul) put(r, 10, 0, S.td, '0.0000');
      else if (l.fParam && pRow[l.fParam] && pVal(l.fParam) > 0) put(r, 10, { f: '1/Premissas!B' + pRow[l.fParam], v: l.c.f }, S.td, '0.0000');
      else put(r, 10, fracExpr(l.f) ? { f: fracExpr(l.f), v: l.c.f } : l.c.f, S.td, '0.0000');
      put(r, 11, { f: `H${R}*I${R}*K${R}`, v: l.c.ttmu }, S.calc, '0.00');
      put(r, 12, { f: `L${R}*${TMU_S}`, v: l.c.sec }, S.calc, '0.00');
      put(r, 13, lineEvid(l, allParams));
      const obs = [];
      if (l.simul) obs.push('Simultâneo ao Nº ' + l.simulWith + ' (frequência real ' + l.f + '): não soma no total.');
      if (l.obs) obs.push(l.obs);
      put(r, 14, obs.join(' '));
      height(r, 39);
    });
    const t = AC0 + L.length;
    put(t, 0, 'TOTAL DO PROCESSO POR ' + UP + (prelim ? ' - CENÁRIO PRELIMINAR' : ''), S.tot); merge(t, 0, t, 10, S.tot);
    put(t, 11, { f: `SUM(L${XR(AC0)}:L${XR(t - 1)})`, v: ctx.totals.tmu }, S.tot, '0.00');
    put(t, 12, { f: `SUM(M${XR(AC0)}:M${XR(t - 1)})`, v: ctx.totals.sec }, S.tot, '0.00');
    put(t, 13, '', S.tot); put(t, 14, '', S.tot);
    height(t, 39);
  }, [7, 24, 65, 18, 25, 16, 95, 12, 13, 17, 10, 18, 16, 33, 90], { aux: true, freeze: { xSplit: 0, ySplit: 5 } });

  /* 3) Premissas */
  sheet('Premissas', (put, merge, XR, height) => {
    put(0, 0, 'PREMISSAS  |  ' + String(st.process || '').toUpperCase(), S.title); merge(0, 0, 0, 5, S.title); height(0, 38);
    put(1, 0, 'Amarelo = editável | parâmetros informados, extraídos do vídeo ou assumidos. Alterar o valor recalcula a Análise Completa.', S.sub); merge(1, 0, 1, 5, S.sub); height(1, 29);
    ['Parâmetro', 'Valor', 'Unidade', 'Origem / critério'].forEach((h, c) => put(3, c, h, S.th)); height(3, 29);
    allParams.forEach((p, i) => {
      const r = PR0 + i; const v = CORE.num(p.value, NaN);
      put(r, 0, p.name); put(r, 1, isFinite(v) && String(p.value).trim() !== '' && !/[a-z]/i.test(String(p.value)) ? v : String(p.value), S.edit, p.id === '_tmu' ? '0.000' : '0.0##');
      put(r, 2, p.unit || ''); put(r, 3, p.origin || ''); height(r, 39);
    });
    let r = PR0 + allParams.length + 1;
    ['ATENÇÃO', 'Status', 'Efeito', 'Como resolver'].forEach((h, c) => put(r, c, h, S.th)); height(r, 29); r++;
    if (!pend.length) { put(r, 0, 'Nenhuma pendência registrada.'); r++; }
    pend.forEach(p => { p.forEach((v, c) => put(r, c, v)); height(r, 39); r++; });
    r++;
    put(r, 0, 'Descrição da operação informada', S.th); merge(r, 0, r, 3, S.th); r++;
    put(r, 0, String(st.prompt || '—').replace(/\s+/g, ' ').trim()); merge(r, 0, r, 3); height(r, 60); r++;
    (st.premises || []).forEach(t => { put(r, 0, 'Premissa do texto: ' + t); merge(r, 0, r, 3); r++; });
  }, [39, 22, 16, 85, 12], { aux: true });

  /* 4) Cronoanálise */
  const filmed = L.filter(l => l.end > l.start).sort((a, b) => a.start - b.start);
  const ob = ctx.observed;
  sheet('Cronoanalise', (put, merge, XR, height) => {
    put(0, 0, 'CRONOANÁLISE  |  O QUE O VÍDEO REALMENTE MOSTRA', S.title); merge(0, 0, 0, 6, S.title); height(0, 38);
    put(1, 0, 'Vídeo ' + (st.filename || '') + ': ' + String(r2(st.duration || 0)).replace('.', ',') + ' s. ' + (st.coverage || '') + (ob.n ? ' Ciclos completos usados na média: ' + ob.n + '.' : ' Nenhum ciclo completo confirmado.'), S.sub); merge(1, 0, 1, 6, S.sub); height(1, 29);
    ['Nº', 'Início (s)', 'Fim (s)', 'Duração (s)', 'Etapa observada', 'Tratamento no MTM', 'Limitação / evidência'].forEach((h, c) => put(3, c, h, S.th)); height(3, 29);
    let r = 4;
    filmed.forEach(l => {
      const R = XR(r);
      put(r, 0, l.n); put(r, 1, l.start, S.td, '0.00'); put(r, 2, l.end, S.td, '0.00'); put(r, 3, { f: `C${R}-B${R}`, v: l.end - l.start }, S.calc, '0.00');
      put(r, 4, l.desc);
      put(r, 5, l.code + (l.c.q !== 1 ? ' × ' + String(r2(l.c.q)).replace('.', ',') : '') + (l.simul ? ' (simultâneo ao Nº ' + l.simulWith + ', não soma)' : '') + (isAcyclic(l) ? ' · rateio ' + l.f : ''));
      put(r, 6, [l.kind === 'pausa' ? 'Baixa movimentação visível' : '', l.obs || ''].filter(Boolean).join('; ') || 'Tempos aproximados pela leitura do vídeo (5 amostras/s)');
      height(r, 39); r++;
    });
    const r0 = 4, r1 = r - 1;
    put(r, 0, 'TOTAL DOS TRECHOS', S.totU); merge(r, 0, r, 2, S.totU);
    put(r, 3, filmed.length ? { f: `SUM(D${XR(r0)}:D${XR(r1)})`, v: filmed.reduce((s, l) => s + l.end - l.start, 0) } : 0, S.totU, '0.00');
    r += 2;
    put(r, 0, 'CICLOS E EVENTOS', S.sec); merge(r, 0, r, 6, S.sec); r++;
    ['Nº', 'Início (s)', 'Fim (s)', 'Duração (s)', 'Tipo', 'Uso no tempo observado', 'Critério / motivo'].forEach((h, c) => put(r, c, h, S.th)); r++;
    if (!st.events.length) { put(r, 0, 'Nenhum ciclo ou evento marcado.'); merge(r, 0, r, 6); r++; }
    st.events.forEach((e, i) => {
      const R = XR(r);
      put(r, 0, i + 1); put(r, 1, e.start, S.td, '0.00'); put(r, 2, e.end, S.td, '0.00'); put(r, 3, { f: `C${R}-B${R}`, v: e.end - e.start }, S.calc, '0.00');
      put(r, 4, e.type);
      put(r, 5, e.type === 'Ciclo completo' ? (e.use ? 'Incluído na média' : 'Não incluído') : e.type === 'Ciclo parcial' ? 'Não entra na média' : (e.exclude ? 'Excluído do tempo' : 'Mantido no tempo'));
      put(r, 6, e.reason || ''); height(r, 39); r++;
    });
    r++;
    const kv = (k, v, fmt) => { put(r, 0, k, S.th); merge(r, 0, r, 2, S.th); put(r, 3, v, S.calc, fmt); r++; };
    kv('Tempo bruto filmado (s)', st.duration || 0, '0.00');
    kv('Média líquida dos ciclos (s)', ob.meanNet == null ? 'n/d' : ob.meanNet, '0.00');
    kv('Ciclos completos na média', ob.n);
  }, [11, 18, 14, 22, 73, 46, 94], { aux: true });

  /* 5) Confronto */
  sheet('Confronto', (put, merge, XR, height) => {
    put(0, 0, 'CONFRONTO  |  MTM × CRONOANÁLISE', S.title); merge(0, 0, 0, 5, S.title); height(0, 38);
    put(1, 0, ob.n ? 'Comparação por ' + U + ' com o mesmo rateio do MTM aplicado ao tempo filmado.' : 'Sem ciclo completo confirmado: comparar apenas as ocorrências filmadas, sem rateio. Não comparar o processo completo com o tempo do vídeo.', S.sub); merge(1, 0, 1, 5, S.sub); height(1, 29);
    ['Indicador', 'Valor', 'Observação'].forEach((h, c) => put(3, c, h, S.th)); height(3, 29);
    let r = 4; const at = {};
    const row = (key, k, v, note, fmt) => { at[key] = XR(r); put(r, 0, k); put(r, 1, v, typeof v === 'string' ? S.td : S.calc, fmt); put(r, 2, note || ''); height(r, 39); r++; };
    row('mtm', 'Tempo MTM do processo por ' + U + ' (s)', { f: `'Analise Completa'!M${acTot}`, v: ctx.totals.sec }, 'Total da Análise Completa (com rateios)', '0.00');
    const fl = filmed.filter(l => !l.simul);
    const occ = fl.reduce((s, l) => s + l.c.tmu * l.c.q * SEC_PER_TMU, 0), obsF = fl.reduce((s, l) => s + l.end - l.start, 0);
    row('mtmF', 'Tempo MTM das ocorrências filmadas, sem rateio (s)', fl.length ? { f: '(' + fl.map(l => `'Analise Completa'!H${acRow(l.n - 1)}*'Analise Completa'!I${acRow(l.n - 1)}`).join('+') + ')*' + TMU_S, v: occ } : 0, 'Nº ' + (fl.map(l => l.n).join(', ') || '—') + ': TMU base × Q de cada ocorrência vista no vídeo', '0.00');
    row('obsF', 'Tempo observado das mesmas ocorrências (s)', obsF, 'Soma das durações filmadas dessas linhas (aba Cronoanalise)', '0.00');
    row('dF', 'Diferença MTM − observado, ocorrências filmadas (s)', fl.length ? { f: `B${at.mtmF}-B${at.obsF}`, v: occ - obsF } : 'n/d', 'Negativo: filme maior do que a decomposição MTM', '0.00');
    row('pF', 'Diferença percentual, ocorrências filmadas (%)', fl.length && obsF ? { f: `IF(B${at.obsF}=0,0,B${at.dF}/B${at.obsF}*100)`, v: (occ - obsF) / obsF * 100 } : 'n/d', '(MTM − observado) ÷ observado × 100', '0.0');
    if (ob.n) {
      row('obs', 'Tempo observado comparável por ' + U + ' (s)', ob.comparable, 'Média cíclica ÷ ' + String(ob.upc).replace('.', ',') + ' ' + (ob.upc === 1 ? U : plural(U)) + ' por ciclo + acíclicas rateadas (' + String(r2(ob.acycRateado)).replace('.', ',') + ' s)', '0.00');
      row('d', 'Diferença MTM − observado por ' + U + ' (s)', { f: `B${at.mtm}-B${at.obs}`, v: ctx.totals.sec - ob.comparable }, 'MTM − observado comparável', '0.00');
      row('p', 'Diferença percentual por ' + U + ' (%)', { f: `IF(B${at.obs}=0,0,B${at.d}/B${at.obs}*100)`, v: ob.comparable ? (ctx.totals.sec - ob.comparable) / ob.comparable * 100 : 0 }, 'Diferença ÷ observado comparável × 100', '0.0');
    }
    row('v', 'Tempo observado do vídeo completo (s)', st.duration || 0, 'Não equivale ao processo por ' + U + ' quando há rateios ou trechos informados', '0.00');
    const notFilmed = L.filter(l => !(l.end > l.start));
    row('nf', 'Linhas sem filmagem', notFilmed.length ? notFilmed.map(l => l.n).join(', ') : 'nenhuma', notFilmed.length ? 'Tempo reconstruído por premissas; não medido no vídeo' : '');
    row('ok', 'Comparação válida por ' + U + '?', ob.n ? 'SIM' : 'NÃO', ob.n ? ob.n + ' ciclo(s) completo(s) confirmado(s)' : 'NÃO: não há ciclo completo confirmado; usar a comparação das ocorrências filmadas');
    row('st', 'Status do cálculo', prelim ? 'PRELIMINAR' : 'CONCLUÍDO', prelim ? 'PRELIMINAR: ' + pend.map(p => p[0]).slice(0, 4).join('; ') + (pend.length > 4 ? '…' : '') : 'Sem pendências registradas');
    r++;
    put(r, 0, 'Diagnóstico de divergência', S.sec); merge(r, 0, r, 5, S.sec); r++;
    const top = [...L].filter(l => l.c.valid).sort((a, b) => b.c.sec - a.c.sec).slice(0, 3);
    const diag = [];
    if (top.length) diag.push('Maiores contribuições ao tempo MTM: ' + top.map(l => 'Nº ' + l.n + ' ' + l.code + ' (' + String(r2(l.c.sec)).replace('.', ',') + ' s)').join(', ') + '. Revisar primeiro distâncias, frequências e enquadramento destas linhas.');
    const big = fl.filter(l => (l.end - l.start) > 0 && l.c.tmu * l.c.q * SEC_PER_TMU > 0).map(l => ({ l, d: (l.end - l.start) - l.c.tmu * l.c.q * SEC_PER_TMU })).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3);
    if (big.length) diag.push('Maiores diferenças entre filmado e MTM por ocorrência: ' + big.map(x => 'Nº ' + x.l.n + ' (' + (x.d > 0 ? 'filme +' : 'MTM +') + String(r2(Math.abs(x.d))).replace('.', ',') + ' s)').join(', ') + '. Verificar omissões, esperas, dificuldade de pega e simultaneidade.');
    diag.push('Não foi acrescentado tempo artificial para coincidir com a filmagem. Os TMU são os da biblioteca; a diferença orienta a revisão do método e das premissas.');
    diag.forEach(t => { put(r, 0, t); merge(r, 0, r, 5); height(r, 39); r++; });
  }, [46, 24, 95, 18, 12, 20], { aux: true });

  /* 6) Biblioteca */
  const codes = [...new Set(L.map(l => l.code))];
  const docs = [...new Set(codes.map(c => (ctx.sourceOf(c) || '').split(' · ')[0]).filter(Boolean))];
  sheet('Biblioteca', (put, merge, XR, height) => {
    put(0, 0, 'BIBLIOTECA MTM  |  CÓDIGOS DA REVISÃO', S.title); merge(0, 0, 0, 4, S.title); height(0, 38);
    put(1, 0, 'Fontes: ' + (docs.join('; ') || 'Biblioteca do sistema') + '.', S.sub); merge(1, 0, 1, 4, S.sub); height(1, 29);
    ['Código', 'Família', 'Descrição técnica da fonte', 'TMU', 'Fonte / parâmetros'].forEach((h, c) => put(3, c, h, S.th)); height(3, 29);
    codes.forEach((c, i) => { const it = library()[c] || {}, src = ctx.sourceOf(c) || '';
      put(4 + i, 0, c); put(4 + i, 1, it.family || ''); put(4 + i, 2, (it.desc || '') + (codeNote(c) ? ' — ' + codeNote(c) : ''));
      put(4 + i, 3, c === 'PT' ? 1666.67 : it.tmu, S.td, '0.0'); put(4 + i, 4, src.split(' · ').slice(1).join(' · ') || src); height(4 + i, 39); });
  }, [14, 26, 88, 12, 70], { aux: true });

  /* 7) Melhorias */
  sheet('Melhorias', (put, merge, XR, height) => {
    put(0, 0, 'MELHORIAS E PONTOS DE CONFIRMAÇÃO', S.title); merge(0, 0, 0, 4, S.title); height(0, 38);
    ['Nº', 'Ponto observado / risco', 'Proposta / validação', 'Impacto no MTM', 'Prioridade'].forEach((h, c) => put(2, c, h, S.th)); height(2, 29);
    const items = st.improvements.filter(m => (m.ponto || m.text || '').trim());
    if (!items.length) put(3, 0, 'Nenhum ponto registrado.');
    items.forEach((m, i) => {
      const z = i % 2 ? S.zeb : S.td, ref = m.ref ? ' (mov. ' + m.ref + (m.evid ? ', ' + m.evid : '') + ')' : (m.evid ? ' (' + m.evid + ')' : '');
      put(3 + i, 0, i + 1, z); put(3 + i, 1, (m.ponto || m.text || '') + ref, z); put(3 + i, 2, m.proposta || '', z);
      put(3 + i, 3, (m.impacto || '') + (m.gain ? (m.impacto ? '; ' : '') + 'ganho estimado ' + m.gain + ' s (fora do tempo do método atual)' : ''), z); put(3 + i, 4, m.prioridade || '', z); height(3 + i, 39);
    });
  }, [8, 79, 100, 87, 16], { aux: true });

  const check = [
    L.length + ' movimentos com código',
    codes.length + ' códigos com fonte',
    'rateios por ' + U,
    'total ' + ctx.totals.tmu.toFixed(2) + ' TMU = resumo',
    prelim ? 'status PRELIMINAR (' + pend.length + ' pendência(s))' : 'status CONCLUÍDO',
  ];
  return { wb, check };
}

})();
