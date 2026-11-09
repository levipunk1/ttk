// Servidor de eventos da live (TikTok -> Roblox)
// Mesmo contrato que o jogo ja usa:
//   GET /api/eventos?desde=<cursor>   header x-api-key
//   -> { cursor, eventos: [ { id, type, user, message, value, ... } ] }
//
// Rodar:  npm install  &&  node server.js
// Painel: http://localhost:3000/   (conectar @, desconectar, simular eventos)

const http = require('http');

const PORT = process.env.PORT || 3000;
const CHAVE = process.env.CHAVE || 'minha-chave-123'; // cole a mesma no painel do jogo (na hospedagem, defina uma chave forte)
const MAX_EVENTOS = 1000;

// ids crescem sempre, mesmo se o servidor reiniciar (o jogo guarda o cursor)
let proximoId = Date.now();
const eventos = [];

function push(ev) {
  ev.id = proximoId++;
  eventos.push(ev);
  if (eventos.length > MAX_EVENTOS) eventos.shift();
}

// ---------------------------------------------------------------- TikTok
let TikTok = null;
try { TikTok = require('tiktok-live-connector'); }
catch (e) { console.log('[aviso] tiktok-live-connector nao instalado: so o simulador funciona. Rode "npm install".'); }

let conexao = null;
let estado = { conectado: false, alvo: '', erro: '' };

const pick = (...v) => v.find((x) => x !== undefined && x !== null && x !== '');
const quem = (d) => String(pick(d.uniqueId, d.user && d.user.uniqueId, d.nickname, d.user && d.user.nickname, ''));

async function conectar(alvo) {
  alvo = String(alvo || '').replace(/^@/, '').trim();
  if (!alvo) throw new Error('informe o @');
  if (!TikTok) throw new Error('tiktok-live-connector nao instalado');
  await desconectar();
  const Classe = TikTok.TikTokLiveConnection || TikTok.WebcastPushConnection;
  const c = new Classe(alvo, { processInitialData: true, fetchRoomInfoOnConnect: true });
  conexao = c;

  c.on('chat', (d) => push({ type: 'COMMENT', user: quem(d), message: String(pick(d.comment, '')) }));
  c.on('follow', (d) => push({ type: 'FOLLOW', user: quem(d) }));
  c.on('like', (d) => push({ type: 'LIKE', user: quem(d), count: Number(pick(d.likeCount, d.count, 1)) }));
  // ---- PRESENTES ----
  // Presente em sequencia (combo) manda varios eventos e um final (repeatEnd). Se o final nunca chega
  // (acontece), o presente era perdido. Agora: guardamos o combo e, se o final nao vier em 6s, enviamos mesmo assim.
  const combos = new Map();
  const positivo = (...v) => { for (const x of v) { const n = Number(x); if (Number.isFinite(n) && n > 0) return n; } return 0; };
  const enviar = (g) => {
    console.log('[presente] ENVIADO ' + g.user + ' | ' + g.nome + ' | ' + g.unidade + ' moedas x' + g.qtd);
    push({ type: 'GIFT', user: g.user, gift: g.nome, diamondCount: g.unidade, amount: g.qtd, value: g.unidade * g.qtd });
  };
  c.on('gift', (d) => {
    const det = d.giftDetails || d.gift || {};
    const ext = d.extendedGiftInfo || {};
    const user = quem(d);
    const tipo = Number(pick(d.giftType, det.giftType, ext.type));
    const nome = String(pick(d.giftName, det.giftName, det.name, ext.name, d.giftId ? 'presente#' + d.giftId : '', ''));
    const unidade = positivo(d.diamondCount, det.diamondCount, ext.diamond_count, ext.diamondCount);
    const qtd = Math.max(1, Math.floor(positivo(d.repeatCount, 1)));
    const fim = d.repeatEnd === true || Number(d.repeatEnd) === 1;
    console.log('[presente] RECEBIDO ' + user + ' | nome="' + nome + '" | moedas=' + unidade + ' | qtd=' + qtd + ' | tipo=' + tipo + ' | repeatEnd=' + d.repeatEnd);
    if (!unidade) { console.log('[presente] IGNORADO (sem valor em moedas). Dados brutos: ' + JSON.stringify(d).slice(0, 800)); return; }

    if (tipo !== 1) { enviar({ user, nome, unidade, qtd }); return; } // presente unico: conta na hora

    const chave = user + '|' + (d.giftId || nome) + '|' + (d.groupId || '');
    const atual = combos.get(chave);
    if (atual) clearTimeout(atual.timer);
    const g = { user, nome, unidade, qtd: Math.max(qtd, atual ? atual.qtd : 0) };
    if (fim) { combos.delete(chave); enviar(g); return; }
    g.timer = setTimeout(() => { combos.delete(chave); enviar(g); }, 6000);
    combos.set(chave, g);
  });
  c.on('disconnected', () => { estado.conectado = false; console.log('[tiktok] desconectado'); });
  c.on('streamEnd', () => { estado.conectado = false; console.log('[tiktok] live encerrada'); });
  c.on('error', (e) => { estado.erro = String(e && e.message || e); console.log('[tiktok] erro:', estado.erro); });

  estado = { conectado: false, alvo, erro: '' };
  try {
    await c.connect();
    estado.conectado = true;
    console.log('[tiktok] conectado em @' + alvo);
  } catch (e) {
    estado.erro = String(e && e.message || e);
    console.log('[tiktok] falha ao conectar:', e && e.stack || e);
    conexao = null;
    throw new Error(estado.erro);
  }
}

async function desconectar() {
  if (conexao) { try { await conexao.disconnect(); } catch (_) {} conexao = null; }
  estado.conectado = false;
}

// ---------------------------------------------------------------- HTTP
const PAINEL = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live server</title>
<style>
 body{font:15px system-ui;background:#161216;color:#eee;max-width:560px;margin:24px auto;padding:0 16px}
 h2{margin:24px 0 8px;font-size:15px;color:#ff5a7a} input,button{font:inherit;padding:9px 12px;border-radius:8px;border:1px solid #444;background:#241c24;color:#eee}
 button{cursor:pointer;background:#ff3b5c;border:0;color:#fff;margin:3px 3px 3px 0} button.g{background:#333}
 .row{display:flex;gap:6px} .row input{flex:1} #st{padding:10px;background:#241c24;border-radius:8px}
</style>
<h1>Live server</h1><div id=st>...</div>
<h2>Conectar na live</h2>
<div class=row><input id=alvo placeholder="@usuario"><button onclick="conectar()">Conectar</button><button class=g onclick="post('/api/desconectar')">Desconectar</button></div>
<h2>Simular eventos</h2>
<div class=row><input id=nome value="tester" style="max-width:140px"><input id=msg value="oi pessoal"><button onclick="sim({type:'COMMENT',message:msg.value})">Comentar</button></div>
<div class=row><input id=gn value="Rose" style="max-width:140px"><input id=gv type=number value=1 style="max-width:90px" title="diamantes"><input id=gq type=number value=1 style="max-width:70px" title="qtd"><button onclick="sim({type:'GIFT',gift:gn.value,diamondCount:+gv.value,amount:+gq.value,value:gv.value*gq.value})">Presente</button></div>
<button onclick="sim({type:'LIKE',count:15})">+15 likes</button><button onclick="sim({type:'FOLLOW'})">Follow</button>
<script>
const key=new URLSearchParams(location.search).get('key')||'';
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json','x-api-key':key},body:JSON.stringify(b||{})});return r.json()}
async function conectar(){const r=await post('/api/conectar',{alvo:alvo.value});if(r.erro)alert(r.erro)}
function sim(e){e.user=nome.value||'tester';post('/api/simular',e)}
async function tick(){try{const r=await (await fetch('/api/estado',{headers:{'x-api-key':key}})).json();
 st.textContent=r.erro==='chave'?'Abra com ?key=SUA_CHAVE na URL':(r.conectado?'Conectado em @'+r.alvo:'Desconectado'+(r.erro?' - '+r.erro:''))+' | eventos na fila: '+r.fila}catch(e){}}
setInterval(tick,1500);tick();
</script>`;

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(obj));
}
function corpo(req) {
  return new Promise((ok) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/' ) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAINEL); }

  const chave = req.headers['x-api-key'] || url.searchParams.get('key');
  if (chave !== CHAVE) return json(res, 401, { erro: 'chave' });

  if (url.pathname === '/api/eventos') {
    const desde = Number(url.searchParams.get('desde')) || 0;
    const novos = eventos.filter((e) => e.id > desde);
    const cursor = novos.length ? novos[novos.length - 1].id : desde;
    return json(res, 200, { cursor, eventos: novos });
  }
  if (url.pathname === '/api/estado') return json(res, 200, { ...estado, fila: eventos.length });
  if (url.pathname === '/api/conectar' && req.method === 'POST') {
    const b = await corpo(req);
    try { await conectar(b.alvo); return json(res, 200, { ok: true }); }
    catch (e) { return json(res, 200, { erro: e.message }); }
  }
  if (url.pathname === '/api/desconectar' && req.method === 'POST') { await desconectar(); return json(res, 200, { ok: true }); }
  if (url.pathname === '/api/simular' && req.method === 'POST') {
    const b = await corpo(req);
    push({ user: 'tester', ...b });
    return json(res, 200, { ok: true });
  }
  json(res, 404, { erro: 'nao encontrado' });
});

server.listen(PORT, () => {
  console.log('Servidor em http://localhost:' + PORT + '/?key=' + CHAVE);
  console.log('Chave do jogo: ' + CHAVE);
  // Hospedagem: se ALVO estiver definido, reconecta sozinho (ex.: depois do servidor acordar ou da live cair)
  if (process.env.ALVO) {
    let ocupado = false;
    const tentar = async () => {
      if (ocupado || estado.conectado) return;
      ocupado = true;
      try { await conectar(process.env.ALVO); }
      catch (e) { console.log('[tiktok] nao conectou (live fora do ar?):', e.message); }
      ocupado = false;
    };
    tentar();
    setInterval(tentar, 30000);
  }
});
