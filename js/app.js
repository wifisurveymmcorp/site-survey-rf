import { DEVICES } from './devices/index.js';
import { save, load } from './store.js';

const $ = id => document.getElementById(id);

const APP_VERSION = '0.8';
const CHANGELOG = [
  ['0.8', 'Linha de limite com alarme (apito e vibração); aviso de nova versão para atualizar sem fechar o app; destravamento do TinySA com prazo em cada passo e reset do USB; log mais limpo (varreduras repetidas viram uma linha com contador).'],
  ['0.7', 'Seletor e selo LOW/HIGH, teste de qual conector tem antena e alerta quando a antena parece estar no conector errado; botão Reiniciar TinySA (comando reset, reconecta sozinho) e destravamento automático quando ele para de responder; Voltar do Android não fecha mais o app de uma vez; tela fica acesa o tempo todo com o app aberto; marcadores M1 a M4 como nos analisadores de bancada: pico, próximo pico, seguir pico, delta em relação ao M1, marcador para centro e para canal; valores dos marcadores salvos em cada ponto, no CSV, no relatório e como métrica do mapa.'],
  ['0.6', 'Canal de interesse como métrica do mapa; RBW, atenuação e offset; perfis salvos; coleta automática andando; vários andares e escala na planta; mapa GPS com OpenStreetMap; zoom no espectro com toque duplo; exportar PNG e relatório em PDF.'],
  ['0.5', 'Nova interface em abas (Medir, Mapa, Dados); modo ao vivo com traços atual, média e max hold; waterfall; pico marcado e leitura ao tocar no gráfico; legenda de cores com limites; reconecta sem pedir para escolher o aparelho de novo.'],
  ['0.4', 'Tela de Ajuda, aviso de espectro plano (antena), indicador online/offline.'],
  ['0.3', 'Testado com TinySA Basic real no Android: conexão por WebUSB, correção das respostas atrasadas, atualizações chegam na hora.'],
  ['0.2', 'App instalável no Android, funciona offline, sessão salva no celular, faixas prontas do Basic (inclui TETRA 380–430 MHz).'],
  ['0.1', 'Protótipo: varredura, marcação na planta e GPS, mapa de calor, exportação CSV/JSON.'],
];
const WF_ROWS = 120;

const state = {
  device: null, connected: false, pos: null, gps: null, points: [],
  live: false,
  trace: null,                       // { freqs, cur, avg, max, n, startMHz, stopMHz, key }
  wf: [],                            // linhas do waterfall (dBm), a mais nova primeiro
  cursor: null,                      // índice tocado no gráfico
  floors: [],                        // [{ id, name, scale: { mPerUnit } }]; imagens em state.planImgs
  floor: null, planImgs: {}, scalePick: null, zoomStack: [], profiles: [],
  markers: [], mkActive: 0, mkDelta: false, // marcadores: [{ f (Hz), track (segue o pico), trace: 'max'|'avg'|'cur' }]
};

// ---------- Log ----------
// Mensagens repetidas (como a mesma varredura no ao vivo) viram uma linha só, com contador
let lastLog = { s: null, n: 0, len: 0 };
function log(s) {
  const el = $('log'), now = new Date().toLocaleTimeString();
  if (s === lastLog.s && el.textContent.length === lastLog.len) {
    lastLog.n++;
    el.textContent = el.textContent.slice(0, lastLog.start) + `[${now}] ${s} (×${lastLog.n})\n`;
  } else {
    lastLog = { s, n: 1, start: el.textContent.length };
    el.textContent += `[${now}] ${s}\n`;
  }
  lastLog.len = el.textContent.length;
  if (el.textContent.length > 50000) el.textContent = el.textContent.slice(-40000);
  el.scrollTop = el.scrollHeight;
}
window.addEventListener('error', e => log('ERRO: ' + e.message));
window.addEventListener('unhandledrejection', e => log('ERRO: ' + (e.reason?.message || e.reason)));
$('btnCopyLog').onclick = () => navigator.clipboard.writeText($('log').textContent).then(() => setStatus('log copiado'));

function setStatus(s, cls = '') { const el = $('capStatus'); el.textContent = s; el.className = 'status ' + cls; }

// Espectro sem nenhum pico acima do ruído costuma ser antena no conector errado ou desligada
function flatHint(dbm, input) {
  const sorted = [...dbm].sort((a, b) => a - b), median = sorted[sorted.length >> 1], max = sorted.at(-1);
  if (max - median >= 6 || max > -80) return '';
  return `espectro plano: confira se a antena está no conector ${input === 'high' ? 'HIGH' : 'LOW'}.`;
}

// ---------- Abas ----------
function showTab(name) {
  for (const b of document.querySelectorAll('nav button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === 'tab-' + name);
  requestAnimationFrame(drawAll);
}
for (const b of document.querySelectorAll('nav button')) b.onclick = () => showTab(b.dataset.tab);

// Botão Voltar do Android (e o botão direito do mouse no scrcpy, que vira Voltar) fechava o app na hora.
// Agora ele fecha a ajuda, volta para a aba Medir e só sai com dois toques seguidos.
let backAt = 0;
history.pushState({ app: 1 }, '');
addEventListener('popstate', () => {
  const tab = document.querySelector('nav button.active')?.dataset.tab;
  if ($('help').open) $('help').close();
  else if (tab !== 'medir') showTab('medir');
  else if (Date.now() - backAt > 2000) { backAt = Date.now(); setStatus('Toque Voltar de novo para sair do app.', 'warn'); }
  else { history.back(); return; }
  history.pushState({ app: 1 }, '');
});

// ---------- Ajuda / estado ----------
$('ver').textContent = 'versão ' + APP_VERSION;
$('changelog').innerHTML = CHANGELOG.map(([v, t]) => `<li><b>${v}</b>: ${t}</li>`).join('');
$('btnHelp').onclick = () => $('help').showModal();
$('btnHelpClose').onclick = () => $('help').close();
$('help').addEventListener('click', e => { if (e.target === $('help')) $('help').close(); });
function showNet() { const on = navigator.onLine; $('net').textContent = on ? 'online' : 'offline'; $('net').classList.toggle('off', !on); }
addEventListener('online', showNet); addEventListener('offline', showNet); showNet();

// ---------- Dispositivo e parâmetros ----------
$('device').innerHTML = DEVICES.map((d, i) => `<option value="${i}">${d.name}</option>`).join('');
function selectDevice() {
  const d = state.device = DEVICES[+$('device').value];
  $('devSummary').textContent = d.name;
  $('preset').innerHTML = '<option value="">— personalizada —</option>' +
    d.bands.map(([n, a, b]) => `<option value="${a},${b}">${n}</option>`).join('');
  for (const [k, id] of [['startMHz', 'fStart'], ['stopMHz', 'fStop'], ['points', 'pts'], ['average', 'avg']])
    if (!$(id).value) $(id).value = d.defaults[k];
  syncPreset(); checkParams();
}
$('device').onchange = () => { selectDevice(); saveSettings(); };

function params() {
  return {
    startMHz: +$('fStart').value, stopMHz: +$('fStop').value, points: Math.max(2, Math.min(450, +$('pts').value | 0)), average: Math.max(1, +$('avg').value | 0),
    input: $('inp').value, rbw: $('rbw').value, att: $('att').value, offset: +$('offset').value || 0,
    chMHz: $('chF').value === '' ? null : +$('chF').value, chBwKHz: +$('chBw').value || 25,
  };
}
const PARAM_IDS = [['startMHz', 'fStart'], ['stopMHz', 'fStop'], ['points', 'pts'], ['average', 'avg'], ['input', 'inp'], ['rbw', 'rbw'], ['att', 'att'], ['offset', 'offset'], ['chMHz', 'chF'], ['chBwKHz', 'chBw']];
function setParams(p) { for (const [k, id] of PARAM_IDS) if (p[k] !== undefined) $(id).value = p[k] ?? ''; syncPreset(); checkParams(); }
function checkParams() {
  const p = params(), c = state.device.check(p);
  $('hint').textContent = c.hint; $('hint').className = 'status ' + (c.ok ? '' : 'bad');
  const name = $('preset').selectedOptions[0]?.value ? $('preset').selectedOptions[0].text : `${p.startMHz}–${p.stopMHz} MHz`;
  $('sweepSummary').textContent = name + (c.input ? ' · ' + c.input.toUpperCase() : '');
  showInput(c.input);
  return c.ok;
}
// Selo LOW/HIGH no espectro: qual conector o TinySA está usando nesta faixa
function showInput(inp) {
  const b = $('inBadge');
  b.textContent = inp ? inp.toUpperCase() : '—';
  b.className = 'inbadge ' + (inp || '');
  b.title = inp ? `Antena no conector ${inp.toUpperCase()}` : 'Faixa inválida';
}
function syncPreset() {
  const v = `${+$('fStart').value},${+$('fStop').value}`;
  $('preset').value = [...$('preset').options].some(o => o.value === v) ? v : '';
}
$('preset').onchange = () => { const v = $('preset').value; if (!v) return; [$('fStart').value, $('fStop').value] = v.split(','); checkParams(); saveSettings(); };
$('inp').addEventListener('change', () => { checkParams(); saveSettings(); });
for (const id of ['fStart', 'fStop', 'pts', 'avg', 'rbw', 'att', 'offset', 'chF', 'chBw']) $(id).addEventListener('input', () => { syncPreset(); checkParams(); saveSettings(); drawSpectrum(); });
$('preset').addEventListener('change', () => { state.zoomStack = []; $('btnZoomBack').disabled = true; });

// ---------- Perfis salvos ----------
function showProfiles() {
  $('profile').innerHTML = '<option value="">—</option>' + state.profiles.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
}
$('profile').onchange = () => { const p = state.profiles[+$('profile').value]; if (p) { setParams(p); saveSettings(); setStatus('Perfil "' + p.name + '" carregado.'); } };
$('btnProfSave').onclick = async () => {
  const cur = state.profiles[+$('profile').value];
  const name = prompt('Nome do perfil:', cur?.name || $('sweepSummary').textContent);
  if (!name) return;
  const i = state.profiles.findIndex(p => p.name === name), p = { name, ...params() };
  if (i >= 0) state.profiles[i] = p; else state.profiles.push(p);
  await save('profiles', state.profiles); showProfiles(); $('profile').value = state.profiles.findIndex(x => x.name === name);
};
$('btnProfDel').onclick = async () => {
  const i = +$('profile').value; if ($('profile').value === '' || !confirm('Excluir o perfil "' + state.profiles[i].name + '"?')) return;
  state.profiles.splice(i, 1); await save('profiles', state.profiles); showProfiles();
};

// Mantém a tela acesa enquanto o app está aberto na frente: se a tela apagar, o Android pode cortar o USB
// e o espelhamento. O Android solta a trava ao trocar de app ou em economia de bateria, então pedimos de novo.
let wakeLock = null, wakeWarned = false;
async function keepAwake(on = true) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) { if (!wakeWarned) log('não foi possível manter a tela acesa: ' + e.message); wakeWarned = true; }
}
document.addEventListener('visibilitychange', () => keepAwake());
addEventListener('pointerdown', () => keepAwake()); // alguns aparelhos só liberam após um toque
keepAwake();

function setConnected(on, text) {
  state.connected = on;
  $('dot').classList.toggle('on', on);
  $('connText').textContent = text;
  $('btnConnect').disabled = on; $('btnDisconnect').disabled = !on; $('btnReboot').disabled = !on; $('device').disabled = on;
  $('btnCapture').disabled = !on; $('btnLive').disabled = !on;
}

$('btnConnect').onclick = async () => {
  $('btnConnect').disabled = true;
  log(`diagnóstico: ${navigator.userAgent} | Web Serial: ${'serial' in navigator ? 'sim' : 'não'} | WebUSB: ${'usb' in navigator ? 'sim' : 'não'} | conexão: ${$('transport').value}`);
  try {
    const v = await state.device.connect({ log, prefer: $('transport').value });
    setConnected(true, v); log('conectado: ' + v); drawSpectrum();
    $('cfgDev').open = false;
    setStatus('Ligue o Ao vivo para acompanhar o sinal, ou toque em Coletar.');
    keepAwake(true);
  } catch (e) {
    $('btnConnect').disabled = false;
    $('connText').textContent = 'erro ao conectar'; setStatus(e.message, 'bad'); log('falha ao conectar: ' + e.message);
  }
};
// Descobre em qual conector está a antena: varre uma faixa com sinais fortes em cada entrada
// (FM no LOW, GSM/LTE 900 no HIGH) e compara o quanto os picos sobem acima do ruído.
const PROBE = { low: [88, 108], high: [880, 960] };
const prominence = d => { const s = [...d].sort((a, b) => a - b); return s.at(-1) - s[s.length >> 1]; };
async function probePort(inp) {
  const [a, b] = PROBE[inp];
  const s = await withDevice(() => state.device.sweep({ startMHz: a, stopMHz: b, points: 145, rbw: 'auto', att: 'auto', input: inp }, { pos: state.pos }));
  const pr = prominence(s.dbm);
  log(`teste ${inp.toUpperCase()} ${a}–${b} MHz: pico ${Math.max(...s.dbm).toFixed(1)} dBm, ${pr.toFixed(1)} dB acima do ruído`);
  return pr;
}
// Alerta de conector errado: se a faixa medida fica plana em duas varreduras seguidas, testa uma vez o outro
// conector; se lá houver sinal, a antena provavelmente está nele.
const portWatch = { flat: 0, probedKey: null };
async function checkPort(p, s) {
  if (!s.input) { hidePortAlert(); return; }
  if (!flatHint(s.dbm, s.input)) { portWatch.flat = 0; portWatch.probedKey = null; hidePortAlert(); return; }
  if (++portWatch.flat < 2) return;
  const key = traceKey(p) + s.input, here = s.input.toUpperCase(), other = s.input === 'low' ? 'high' : 'low', OTHER = other.toUpperCase();
  if (portWatch.probedKey === key) return;
  portWatch.probedKey = key;
  let pr = 0;
  try { pr = await probePort(other); } catch (e) { log('teste do outro conector: ' + e.message); }
  if (pr >= 10) showPortAlert(`A antena parece estar no conector <b>${OTHER}</b>, mas esta faixa é medida pelo <b>${here}</b>. Passe a antena para o ${here}, ou use uma faixa ${other === 'high' ? 'de 240 a 960 MHz' : 'abaixo de 350 MHz'}.`);
  else showPortAlert(`Sem sinal no conector <b>${here}</b>. Confira se a antena está ligada no ${here}.`);
}
function showPortAlert(html) {
  const el = $('portAlert'), was = !el.hidden;
  el.innerHTML = '⚠ ' + html; el.hidden = false;
  if (!was) { log('alerta: ' + el.textContent); if (navigator.vibrate) navigator.vibrate([200, 100, 200]); }
}
function hidePortAlert() { $('portAlert').hidden = true; }
$('btnWhichPort').onclick = async () => {
  if (!state.connected) { setStatus('Conecte o TinySA antes.', 'bad'); return; }
  $('btnWhichPort').disabled = true; setStatus('Testando os conectores LOW e HIGH…');
  try {
    const low = await probePort('low'), high = await probePort('high'), txt = `LOW ${low.toFixed(0)} dB, HIGH ${high.toFixed(0)} dB acima do ruído`;
    if (low < 8 && high < 8) setStatus(`Nenhum conector com sinal claro (${txt}). Confira a antena.`, 'warn');
    else if (Math.abs(low - high) < 6) setStatus(`Os dois conectores têm sinal (${txt}).`);
    else { const p = low > high ? 'LOW' : 'HIGH'; setStatus(`A antena parece estar no conector ${p} (${txt}).`, 'ok'); }
  } catch (e) { setStatus('Teste falhou: ' + e.message, 'bad'); log('teste de conector: ' + e.message); }
  $('btnWhichPort').disabled = false;
};
// Reinicia o aparelho (comando reset) e reconecta sem pedir permissão de novo
$('btnReboot').onclick = async () => {
  if (!confirm('Reiniciar o TinySA? Leva uns 10 segundos e ele reconecta sozinho.')) return;
  $('btnReboot').disabled = true;
  await withDevice(async () => {
    setStatus('Reiniciando o TinySA…', 'warn');
    try { const v = await state.device.reboot(); $('connText').textContent = v; setStatus('TinySA reiniciado e conectado.'); log('reiniciado: ' + v); }
    catch (e) {
      setStatus('Não reconectou: ' + e.message + '. Desligue e ligue o TinySA e toque em Conectar.', 'bad'); log('reinício falhou: ' + e.message);
      setLive(false); await state.device.disconnect(); setConnected(false, 'desconectado');
    }
  });
  $('btnReboot').disabled = !state.connected;
};
$('btnDisconnect').onclick = async () => {
  setLive(false); $('autoCap').checked = false;
  await withDevice(() => state.device.disconnect());
  setConnected(false, 'desconectado');
};

// ---------- Traços (atual, média, max hold) e waterfall ----------
function traceKey(p) { return `${p.startMHz}|${p.stopMHz}|${p.points}`; }
function resetTrace() { portWatch.flat = 0; portWatch.probedKey = null; hidePortAlert(); state.trace = null; state.wf = []; state.cursor = null; drawSpectrum(); drawWaterfall(); }
$('btnResetMax').onclick = () => { if (state.trace) { state.trace.max = state.trace.cur.slice(); state.trace.avgLin = state.trace.cur.map(v => 10 ** (v / 10)); state.trace.n = 1; state.trace.avg = state.trace.cur.slice(); } drawSpectrum(); };

function addSweep(p, s) {
  const key = traceKey(p);
  let t = state.trace;
  if (!t || t.key !== key || t.freqs.length !== s.dbm.length) {
    t = state.trace = { key, freqs: s.freqs, startMHz: p.startMHz, stopMHz: p.stopMHz, cur: s.dbm, max: s.dbm.slice(), avgLin: s.dbm.map(v => 10 ** (v / 10)), n: 1, input: s.input };
    state.wf = [];
  } else {
    t.cur = s.dbm; t.freqs = s.freqs; t.input = s.input;
    t.max = t.max.map((v, i) => Math.max(v, s.dbm[i]));
    // média exponencial em potência linear (estável no modo ao vivo)
    const a = 1 / Math.min(++t.n, 8);
    t.avgLin = t.avgLin.map((v, i) => v * (1 - a) + 10 ** (s.dbm[i] / 10) * a);
  }
  t.avg = t.avgLin.map(v => 10 * Math.log10(v));
  state.wf.unshift(s.dbm); if (state.wf.length > WF_ROWS) state.wf.length = WF_ROWS;
  drawSpectrum(); drawWaterfall();
}

// Fila de acesso ao aparelho: ao vivo, coleta e reinício esperam a vez, na ordem em que foram pedidos
let devQueue = Promise.resolve();
function withDevice(fn) { const r = devQueue.then(fn, fn); devQueue = r.catch(() => {}); return r; }
function sweepOnce(p) { return withDevice(() => sweepNow(p)); }
async function sweepNow(p) {
  let s;
  try { s = await state.device.sweep(p, { pos: state.pos }); }
  catch (e) {
    // Travou ou respondeu errado: tenta destravar uma vez e repetir a varredura
    if (!state.device.recover) throw e;
    log('varredura falhou (' + e.message + '); tentando destravar');
    setStatus('O TinySA não respondeu; destravando…', 'warn');
    try {
      await Promise.race([state.device.recover(), new Promise((_, rej) => setTimeout(() => rej(new Error('não destravou em 25 s')), 25000))]);
      s = await state.device.sweep(p, { pos: state.pos });
    }
    catch (e2) { throw new Error(e2.message + ' — toque em Reiniciar TinySA, ou desligue e ligue o aparelho'); }
    setStatus('TinySA destravado, seguindo.');
  }
  if (p.offset) s.dbm = s.dbm.map(v => v + p.offset);
  return s;
}

let capturing = false;
async function liveLoop() {
  while (state.live && state.connected) {
    if (capturing || !checkParams()) { await new Promise(r => setTimeout(r, 200)); continue; }
    const p = params(), t0 = performance.now();
    try {
      const s = await sweepOnce(p);
      addSweep(p, s);
      checkLimit(s);
      await checkPort(p, s);
      $('sweepRate').textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s/varredura`;
    } catch (e) { log('ao vivo: ' + e.message); setStatus('Ao vivo parou: ' + e.message, 'bad'); setLive(false); }
  }
}
function setLive(on) {
  state.live = on;
  $('btnLive').classList.toggle('on', on);
  $('btnLive').textContent = on ? 'Ao vivo ●' : 'Ao vivo';
  if (on) { $('cfgSweep').open = false; liveLoop(); }
}
$('btnLive').onclick = () => setLive(!state.live);

// ---------- GPS ----------
function getGps() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(
      p => res({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy }),
      e => { log('GPS: ' + e.message); res(null); },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
  });
}
function showGps() { $('gps').value = state.gps ? `${state.gps.lat.toFixed(6)}, ${state.gps.lon.toFixed(6)} ±${Math.round(state.gps.acc)}m` : ''; }
$('gps').onclick = async () => { state.gps = await getGps(); showGps(); };
$('autoGps').onchange = saveSettings;

// ---------- Coleta ----------
function metrics(f, p, prm = {}) {
  let iMax = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[iMax]) iMax = i;
  const sum = p.reduce((a, v) => a + Math.pow(10, v / 10), 0);
  const m = { max: p[iMax], fmax: f[iMax], mean: 10 * Math.log10(sum / p.length), chpow: 10 * Math.log10(sum), ch: null };
  // canal de interesse: potência somada dos pontos dentro da largura; se o canal for mais estreito que um ponto, o ponto mais próximo
  if (prm.chMHz != null) {
    const c = prm.chMHz * 1e6, half = prm.chBwKHz * 500;
    let lin = 0, n = 0, near = 0;
    f.forEach((fr, i) => { if (Math.abs(fr - c) <= half) { lin += 10 ** (p[i] / 10); n++; } if (Math.abs(fr - c) < Math.abs(f[near] - c)) near = i; });
    if (c >= f[0] && c <= f.at(-1)) m.ch = n ? 10 * Math.log10(lin) : p[near];
  }
  return m;
}
const metricVal = (p, key) => p[key] ?? null; // inclui m1..m4 (dBm nos marcadores)

$('btnCapture').onclick = () => capture();
async function capture() {
  if (!checkParams()) { setStatus('Ajuste a faixa antes de coletar.', 'bad'); return; }
  if (capturing) return;
  const prm = params();
  $('btnCapture').disabled = true; capturing = true;
  try {
    const gpsP = $('autoGps').checked ? getGps() : Promise.resolve(state.gps);
    let acc = null, freqs, input, maxHold = null;
    for (let k = 0; k < prm.average; k++) {
      setStatus(`Varrendo ${k + 1}/${prm.average}…`);
      const s = await sweepOnce(prm);
      addSweep(prm, s);
      freqs = s.freqs; input = s.input;
      const lin = s.dbm.map(v => Math.pow(10, v / 10));
      acc = acc ? acc.map((v, i) => v + (lin[i] ?? 0)) : lin;
      maxHold = maxHold ? maxHold.map((v, i) => Math.max(v, s.dbm[i])) : s.dbm.slice();
    }
    const dbm = acc.map(v => 10 * Math.log10(v / prm.average));
    state.gps = await gpsP; showGps();
    const m = { ...metrics(freqs, dbm, prm), ...markerValues(freqs, dbm, maxHold) };
    const rec = {
      id: (state.points.at(-1)?.id || 0) + 1, label: $('label').value.trim(), time: new Date().toISOString(),
      device: state.device.id, input, pos: state.pos, floor: state.pos ? state.floor : null, xm: toMeters(state.pos)?.[0], ym: toMeters(state.pos)?.[1], gps: state.gps, ...prm, freqs, dbm, maxhold: maxHold, ...m,
    };
    rec.label ||= 'P' + rec.id;
    state.points.push(rec);
    setStatus(`${rec.label}: pico ${m.max.toFixed(1)} dBm em ${(m.fmax / 1e6).toFixed(3)} MHz`);
    checkPort(prm, { dbm, input: rec.input });
    const flat = flatHint(dbm, rec.input);
    if (flat) { setStatus($('capStatus').textContent + ' — ' + flat, 'warn'); log('aviso: ' + flat); }
    if (navigator.vibrate) navigator.vibrate(80);
    $('label').value = '';
    await save('points', state.points);
    drawPlan(); drawTable();
  } catch (e) { setStatus('Erro: ' + e.message, 'bad'); log('erro na coleta: ' + e.message); }
  capturing = false;
  $('btnCapture').disabled = !state.connected;
}

// Coleta automática: um ponto a cada N segundos enquanto a opção estiver marcada
let autoTimer = null;
async function autoLoop() {
  while ($('autoCap').checked && state.connected) {
    const t0 = Date.now();
    await capture();
    const wait = Math.max(0, Math.max(2, +$('autoSec').value || 10) * 1000 - (Date.now() - t0));
    await new Promise(r => { autoTimer = setTimeout(r, wait); });
  }
}
$('autoCap').onchange = () => { clearTimeout(autoTimer); if ($('autoCap').checked) { if (!state.connected) { $('autoCap').checked = false; setStatus('Conecte o dispositivo antes.', 'bad'); return; } autoLoop(); } };

// ---------- Desenho ----------
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
// Ajusta a resolução do canvas ao tamanho na tela (nítido em telas de alta densidade)
function fit(c) {
  const r = c.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  return { W: w, H: h, dpr };
}
const fmtMHz = hz => (hz / 1e6).toFixed(hz >= 1e8 ? 2 : 3);
function niceStep(span, target) {
  const raw = span / target, p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw);
}
const SPEC_PAD = { l: 44, r: 10, t: 22, b: 24 };
function drawSpectrum() {
  const c = $('spec'); if (!c.offsetParent) return;
  const { W, H, dpr } = fit(c), g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = W / dpr, h = H / dpr, P = SPEC_PAD;
  g.clearRect(0, 0, w, h);
  g.font = '11px system-ui'; g.fillStyle = css('--muted');
  const t = state.trace;
  if (!t) { showMarkerTable(state.markers.map(m => ({ f: m.f, dbm: null, trace: m.trace, track: m.track }))); g.fillText(state.connected ? 'Toque em Ao vivo ou Coletar para ver o espectro.' : 'Conecte o TinySA para ver o espectro.', 12, 24); return; }
  const lim = limit(), all = [...t.max, ...t.cur, ...(lim != null ? [lim] : [])];
  const lo = Math.floor(Math.min(...t.cur) / 10) * 10 - 10, hi = Math.ceil(Math.max(...all) / 10) * 10 + 5;
  const f0 = t.freqs[0], f1 = t.freqs.at(-1);
  const X = f => P.l + (f - f0) / (f1 - f0) * (w - P.l - P.r), Y = v => P.t + (hi - v) / (hi - lo) * (h - P.t - P.b);
  // grade
  g.strokeStyle = css('--line'); g.lineWidth = 1; g.textAlign = 'right';
  for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) { g.beginPath(); g.moveTo(P.l, Y(v)); g.lineTo(w - P.r, Y(v)); g.stroke(); g.fillText(v, P.l - 6, Y(v) + 4); }
  g.textAlign = 'center';
  const step = niceStep((f1 - f0) / 1e6, Math.max(2, Math.floor((w - P.l) / 80))) * 1e6;
  for (let f = Math.ceil(f0 / step) * step; f <= f1 + 1; f += step) {
    g.beginPath(); g.moveTo(X(f), P.t); g.lineTo(X(f), h - P.b); g.stroke();
    g.fillText((f / 1e6).toFixed(step < 1e6 ? 1 : 0), X(f), h - 8);
  }
  g.textAlign = 'left'; g.fillText('dBm', 4, 12); g.textAlign = 'right'; g.fillText('MHz', w - P.r, h - 8 - 12);
  // canal de interesse
  const prm = params();
  if (prm.chMHz != null) {
    const c = prm.chMHz * 1e6, half = Math.max(prm.chBwKHz * 500, (f1 - f0) / t.freqs.length / 2);
    if (c + half >= f0 && c - half <= f1) {
      g.fillStyle = 'rgba(46,160,67,.18)'; g.fillRect(X(Math.max(f0, c - half)), P.t, Math.max(2, X(Math.min(f1, c + half)) - X(Math.max(f0, c - half))), h - P.t - P.b);
      g.fillStyle = css('--ok'); g.font = '600 11px system-ui'; g.textAlign = 'center'; g.fillText('canal', X(c), P.t + 12); g.font = '11px system-ui';
    }
  }
  // linha de limite
  if (lim != null) {
    g.strokeStyle = css('--bad'); g.lineWidth = 1.2; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(P.l, Y(lim)); g.lineTo(w - P.r, Y(lim)); g.stroke(); g.setLineDash([]);
    g.fillStyle = css('--bad'); g.font = '600 11px system-ui'; g.textAlign = 'right'; g.fillText(`limite ${lim} dBm`, w - P.r - 2, Y(lim) - 4); g.font = '11px system-ui';
  }
  // traços
  const line = (arr, color, width) => { g.strokeStyle = color; g.lineWidth = width; g.beginPath(); arr.forEach((v, i) => i ? g.lineTo(X(t.freqs[i]), Y(v)) : g.moveTo(X(t.freqs[i]), Y(v))); g.stroke(); };
  line(t.max, css('--tr-max'), 1.2);
  line(t.avg, css('--tr-avg'), 1.2);
  line(t.cur, css('--tr-live'), 1.6);
  // pico do max hold (só quando não há marcadores, para não poluir)
  if (!state.markers.length) {
    let ip = 0; t.max.forEach((v, i) => { if (v > t.max[ip]) ip = i; });
    const px = X(t.freqs[ip]), py = Y(t.max[ip]);
    g.fillStyle = css('--tr-max'); g.beginPath(); g.moveTo(px, py - 3); g.lineTo(px - 5, py - 11); g.lineTo(px + 5, py - 11); g.fill();
    g.font = '600 11px system-ui'; g.textAlign = px > w - 120 ? 'right' : 'left';
    g.fillStyle = css('--fg'); g.fillText(`pico ${t.max[ip].toFixed(1)} dBm · ${fmtMHz(t.freqs[ip])} MHz`, px + (g.textAlign === 'left' ? 8 : -8), Math.max(12, py - 12));
  }
  // marcadores
  const mks = resolveMarkers(t);
  mks.forEach((m, k) => {
    const mx = X(t.freqs[m.i]), my = Y(m.dbm), col = MK_COLORS[k], act = k === state.mkActive;
    if (act) { g.strokeStyle = col; g.setLineDash([3, 3]); g.lineWidth = 1; g.beginPath(); g.moveTo(mx, P.t); g.lineTo(mx, h - P.b); g.stroke(); g.setLineDash([]); }
    g.fillStyle = col; g.strokeStyle = css('--bg'); g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(mx, my - 2); g.lineTo(mx - 6, my - 12); g.lineTo(mx + 6, my - 12); g.closePath(); g.fill(); g.stroke();
    g.font = '700 11px system-ui'; g.textAlign = 'center'; g.fillText(String(k + 1), mx, Math.max(11, my - 15));
  });
  showMarkerTable(mks, t);
  // leitura: marcador ativo, ou o ponto tocado quando não há marcadores
  const ri = mks.length ? mks[state.mkActive]?.i : state.cursor;
  if (!mks.length && ri != null && ri < t.freqs.length) {
    const cx = X(t.freqs[ri]);
    g.strokeStyle = css('--fg'); g.setLineDash([4, 3]); g.lineWidth = 1; g.beginPath(); g.moveTo(cx, P.t); g.lineTo(cx, h - P.b); g.stroke(); g.setLineDash([]);
  }
  if (ri != null && ri < t.freqs.length) $('readout').textContent = `${fmtMHz(t.freqs[ri])} MHz — atual ${t.cur[ri].toFixed(1)} · média ${t.avg[ri].toFixed(1)} · max ${t.max[ri].toFixed(1)} dBm`;
  else $('readout').textContent = 'Toque no gráfico para ler um valor.';
}

// ---------- Linha de limite ----------
const limit = () => $('limDbm').value === '' ? null : +$('limDbm').value;
let audioCtx = null, lastAlarm = 0;
function beep() {
  try {
    audioCtx ??= new AudioContext();
    const o = audioCtx.createOscillator(), gn = audioCtx.createGain();
    o.frequency.value = 1800; gn.gain.value = 0.2; o.connect(gn); gn.connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.25);
  } catch (_) {}
}
// Confere a varredura contra o limite; com o alarme ligado apita e vibra (no máximo a cada 2 s)
function checkLimit(s) {
  const lim = limit(); if (lim == null) { $('limState').textContent = ''; return; }
  let i = -1; s.dbm.forEach((v, k) => { if (v > lim && (i < 0 || v > s.dbm[i])) i = k; });
  if (i < 0) { $('limState').textContent = 'abaixo do limite'; $('limState').className = 'status'; return; }
  const txt = `acima: ${s.dbm[i].toFixed(1)} dBm em ${fmtMHz(s.freqs[i])} MHz`;
  $('limState').textContent = txt; $('limState').className = 'status bad';
  if ($('limAlarm').classList.contains('on') && Date.now() - lastAlarm > 2000) {
    lastAlarm = Date.now(); beep(); if (navigator.vibrate) navigator.vibrate(150); log('alarme de limite: ' + txt);
  }
}
$('limDbm').addEventListener('input', () => { saveSettings(); drawSpectrum(); if (state.trace) checkLimit({ dbm: state.trace.cur, freqs: state.trace.freqs }); });
$('limAlarm').onclick = () => { $('limAlarm').classList.toggle('on'); if ($('limAlarm').classList.contains('on')) { beep(); if (limit() == null) setStatus('Digite o limite em dBm para o alarme funcionar.', 'warn'); } saveSettings(); };

// ---------- Marcadores ----------
const MK_COLORS = ['#e5484d', '#3e63dd', '#2f9e44', '#c77d00'];
const MK_TRACES = { max: 'Max hold', avg: 'Média', cur: 'Atual' };
const nearestIdx = (freqs, f) => { let b = 0; freqs.forEach((x, i) => { if (Math.abs(x - f) < Math.abs(freqs[b] - f)) b = i; }); return b; };
const argMax = a => a.reduce((b, v, i) => v > a[b] ? i : b, 0);
// Picos locais: maior valor numa janela de ±k pontos (ignora o "serrilhado" do ruído)
function localPeaks(a) {
  const k = Math.max(2, Math.round(a.length / 100)), out = [];
  for (let i = 0; i < a.length; i++) {
    let top = true;
    for (let j = Math.max(0, i - k); j <= Math.min(a.length - 1, i + k) && top; j++) if (a[j] > a[i] || (a[j] === a[i] && j < i)) top = false;
    if (top) out.push(i);
  }
  return out;
}
// Posição de cada marcador na varredura atual; os que seguem o pico andam junto com ele
function resolveMarkers(t, arrs = t) {
  return state.markers.map(m => {
    const a = arrs[m.trace] || arrs.cur;
    const i = m.track ? argMax(a) : nearestIdx(t.freqs, m.f);
    if (m.track) m.f = t.freqs[i];
    return { i, f: t.freqs[i], dbm: a[i], trace: m.trace, track: m.track };
  });
}
function showMarkerTable(mks, t) {
  const ref = mks[0];
  $('mkTable').innerHTML = mks.map((m, k) => {
    const d = state.mkDelta && k > 0 && ref;
    const val = m.dbm == null ? `${fmtMHz(m.f)} MHz · aguardando varredura` : d ? `Δ ${((m.f - ref.f) / 1e3).toFixed(1)} kHz · ${(m.dbm - ref.dbm >= 0 ? '+' : '') + (m.dbm - ref.dbm).toFixed(1)} dB` : `${fmtMHz(m.f)} MHz · ${m.dbm.toFixed(1)} dBm`;
    return `<tr data-mk="${k}" class="${k === state.mkActive ? 'act' : ''}"><td><b style="color:${MK_COLORS[k]}">M${k + 1}</b></td><td>${val}</td><td>${MK_TRACES[m.trace]}${m.track ? ' · segue pico' : ''}</td></tr>`;
  }).join('');
  showMarkerBar();
}
function showMarkerBar() {
  const m = state.markers[state.mkActive], has = !!m;
  for (const id of ['mkPeak', 'mkNext', 'mkTrack', 'mkCenter', 'mkCh', 'mkDel', 'mkTrace']) $(id).disabled = !has;
  $('mkAdd').disabled = state.markers.length >= 4;
  $('mkDelta').disabled = state.markers.length < 2;
  $('mkTrack').classList.toggle('on', !!m?.track);
  $('mkDelta').classList.toggle('on', state.mkDelta);
  if (m) $('mkTrace').value = m.trace;
  $('mkHint').textContent = has ? `Arraste no gráfico para mover o M${state.mkActive + 1}. Toque numa linha da tabela para escolher outro marcador.` : 'Sem marcadores: toque no gráfico para ler um valor.';
}
function saveMarkers() { save('markers', { list: state.markers, active: state.mkActive, delta: state.mkDelta }); }
function markersChanged() { saveMarkers(); drawSpectrum(); }
const curMk = () => state.markers[state.mkActive];
$('mkAdd').onclick = () => {
  if (state.markers.length >= 4) return;
  const t = state.trace;
  // o primeiro vai para o pico; os seguintes para o próximo pico livre
  const m = { f: 0, track: false, trace: curMk()?.trace || 'max' };
  if (t) {
    const a = t[m.trace], used = resolveMarkers(t).map(x => x.i);
    const free = localPeaks(a).filter(i => !used.includes(i)).sort((x, y) => a[y] - a[x]);
    m.f = t.freqs[free[0] ?? argMax(a)];
  } else { const p = params(); m.f = (p.startMHz + p.stopMHz) / 2 * 1e6; m.track = !state.markers.length; }
  state.markers.push(m); state.mkActive = state.markers.length - 1; markersChanged();
};
$('mkPeak').onclick = () => { const m = curMk(), t = state.trace; if (!m || !t) return; m.f = t.freqs[argMax(t[m.trace])]; markersChanged(); };
// Próximo pico: o maior pico local abaixo do nível atual do marcador
$('mkNext').onclick = () => {
  const m = curMk(), t = state.trace; if (!m || !t) return;
  const a = t[m.trace], i0 = nearestIdx(t.freqs, m.f), lvl = a[i0];
  const cand = localPeaks(a).filter(i => i !== i0 && (a[i] < lvl || (a[i] === lvl && i > i0))).sort((x, y) => a[y] - a[x]);
  if (!cand.length) { setStatus('Não há outro pico abaixo deste.'); return; }
  m.track = false; m.f = t.freqs[cand[0]]; markersChanged();
};
$('mkTrack').onclick = () => { const m = curMk(); if (!m) return; m.track = !m.track; markersChanged(); };
$('mkDelta').onclick = () => { state.mkDelta = !state.mkDelta; markersChanged(); };
$('mkTrace').onchange = () => { const m = curMk(); if (!m) return; m.trace = $('mkTrace').value; markersChanged(); };
$('mkDel').onclick = () => { state.markers.splice(state.mkActive, 1); state.mkActive = Math.max(0, Math.min(state.mkActive, state.markers.length - 1)); markersChanged(); };
// Marcador → centro: mantém a largura e centraliza a varredura na frequência do marcador
$('mkCenter').onclick = () => {
  const m = curMk(); if (!m) return;
  const p = params(), span = p.stopMHz - p.startMHz, f = m.f / 1e6;
  let a = f - span / 2, b = f + span / 2;
  for (const [lo, hi] of [[0.1, 350], [240, 960]]) if (p.startMHz >= lo && p.stopMHz <= hi) { if (a < lo) { b += lo - a; a = lo; } if (b > hi) { a -= b - hi; b = hi; } }
  state.zoomStack.push([p.startMHz, p.stopMHz]); $('btnZoomBack').disabled = false;
  setParams({ startMHz: +a.toFixed(3), stopMHz: +b.toFixed(3) }); saveSettings();
  setStatus(`Centro em ${f.toFixed(3)} MHz`);
};
// Marcador → canal: usa a frequência do marcador como canal de interesse
$('mkCh').onclick = () => {
  const m = curMk(); if (!m) return;
  $('chF').value = (m.f / 1e6).toFixed(4); if (!$('chBw').value) $('chBw').value = 12.5;
  checkParams(); saveSettings(); drawSpectrum(); setStatus(`Canal de interesse: ${(m.f / 1e6).toFixed(4)} MHz`);
};
$('mkTable').onclick = e => { const tr = e.target.closest('tr'); if (!tr) return; state.mkActive = +tr.dataset.mk; markersChanged(); };
// Valores dos marcadores num ponto coletado (média e max hold da coleta)
function markerValues(freqs, dbm, maxhold) {
  const t = { freqs }, out = {};
  const mk = resolveMarkers(t, { cur: dbm, avg: dbm, max: maxhold || dbm });
  mk.forEach((m, k) => { out['m' + (k + 1)] = m.dbm; out['m' + (k + 1) + 'f'] = m.f; });
  return out;
}

function specIndexAt(clientX) {
  const t = state.trace; if (!t) return null;
  const r = $('spec').getBoundingClientRect(), x = clientX - r.left;
  const frac = (x - SPEC_PAD.l) / (r.width - SPEC_PAD.l - SPEC_PAD.r);
  return Math.max(0, Math.min(t.freqs.length - 1, Math.round(frac * (t.freqs.length - 1))));
}
// Toque/arrasto: move o marcador ativo (que deixa de seguir o pico) ou, sem marcadores, só lê o valor
function specTouch(e) {
  const i = specIndexAt(e.clientX); if (i == null) return;
  const m = curMk();
  if (m) { m.f = state.trace.freqs[i]; m.track = false; saveMarkers(); } else state.cursor = i;
  drawSpectrum();
}
$('spec').addEventListener('pointerdown', e => { specTouch(e); $('spec').setPointerCapture(e.pointerId); });
// Toque duplo: aproxima 4x em torno da frequência tocada (respeitando os limites do dispositivo)
let lastTap = 0;
$('spec').addEventListener('pointerup', e => {
  const now = Date.now();
  if (now - lastTap < 350 && state.trace) zoomAt(state.trace.freqs[specIndexAt(e.clientX)] / 1e6);
  lastTap = now;
});
function zoomAt(fMHz) {
  const p = params(), span = (p.stopMHz - p.startMHz) / 4;
  if (span < 0.05) return;
  let a = fMHz - span / 2, b = fMHz + span / 2;
  for (const [lo, hi] of [[0.1, 350], [240, 960]]) if (p.startMHz >= lo && p.stopMHz <= hi) { if (a < lo) { b += lo - a; a = lo; } if (b > hi) { a -= b - hi; b = hi; } }
  state.zoomStack.push([p.startMHz, p.stopMHz]); $('btnZoomBack').disabled = false;
  setParams({ startMHz: +a.toFixed(3), stopMHz: +b.toFixed(3) }); saveSettings();
  setStatus(`Zoom: ${a.toFixed(3)}–${b.toFixed(3)} MHz`);
}
$('btnZoomBack').onclick = () => {
  const z = state.zoomStack.pop(); if (!z) return;
  setParams({ startMHz: z[0], stopMHz: z[1] }); saveSettings();
  $('btnZoomBack').disabled = !state.zoomStack.length;
};
$('spec').addEventListener('pointermove', e => { if (e.buttons) specTouch(e); });

const heat = (t, a) => `hsla(${(1 - Math.max(0, Math.min(1, t))) * 240},85%,50%,${a})`;
function drawWaterfall() {
  const c = $('wf'); if (!c.offsetParent) return;
  const t = state.trace, g = c.getContext('2d');
  if (!t || !state.wf.length) { const { W, H } = fit(c); g.clearRect(0, 0, W, H); return; }
  // uma coluna por ponto, uma linha por varredura; o CSS estica para o tamanho da tela
  const n = t.freqs.length;
  if (c.width !== n || c.height !== WF_ROWS) { c.width = n; c.height = WF_ROWS; }
  const all = state.wf.flat(), lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const img = g.createImageData(n, WF_ROWS);
  state.wf.forEach((row, y) => row.forEach((v, x) => {
    const [r, gg, b] = hslToRgb((1 - (v - lo) / span) * 240, 0.85, 0.5), k = (y * n + x) * 4;
    img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = b; img.data[k + 3] = 255;
  }));
  g.putImageData(img, 0, 0);
}
function hslToRgb(h, s, l) {
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function scaleRange(vals) {
  const lo = $('lo').value === '' ? Math.min(...vals) : +$('lo').value;
  const hi = $('hi').value === '' ? Math.max(...vals) : +$('hi').value;
  return [lo, hi > lo ? hi : lo + 1];
}
const fmtV = v => v == null ? '—' : v.toFixed(1);
function colorLabels(vals) {
  const [lo, hi] = vals.length ? scaleRange(vals) : [NaN, NaN];
  $('loLbl').textContent = isFinite(lo) ? lo.toFixed(0) + ' dBm' : ''; $('hiLbl').textContent = isFinite(hi) ? hi.toFixed(0) + ' dBm' : '';
  return [lo, hi];
}
function drawMarker(g, x, y, val, label, lo, span) {
  g.fillStyle = val == null ? '#888' : heat((val - lo) / span, 1); g.beginPath(); g.arc(x, y, 11, 0, 7); g.fill();
  g.strokeStyle = '#000'; g.lineWidth = 2; g.stroke();
  const t = `${label} ${fmtV(val)}`;
  g.font = 'bold 20px system-ui'; g.lineWidth = 4; g.strokeStyle = '#fff'; g.strokeText(t, x + 14, y - 8); g.fillStyle = '#000'; g.fillText(t, x + 14, y - 8);
}

// ---------- Andares e planta ----------
const curFloor = () => state.floors.find(f => f.id === state.floor);
function showFloors() {
  $('floor').innerHTML = state.floors.map(f => `<option value="${f.id}">${esc(f.name)}</option>`).join('');
  $('floor').value = state.floor;
}
async function saveFloors() { await save('floors', state.floors.map(({ id, name, scale }) => ({ id, name, scale }))); await save('floorCur', state.floor); }
$('floor').onchange = () => { state.floor = +$('floor').value; state.pos = null; $('xy').value = ''; sizePlan(); drawPlan(); saveFloors(); };
$('btnFloorAdd').onclick = async () => {
  const name = prompt('Nome do andar:', `Andar ${state.floors.length + 1}`); if (!name) return;
  const id = Math.max(0, ...state.floors.map(f => f.id)) + 1;
  state.floors.push({ id, name, scale: null }); state.floor = id; state.pos = null; $('xy').value = '';
  showFloors(); sizePlan(); drawPlan(); await saveFloors();
};
// Escala: dois toques na planta + distância real em metros
$('btnScale').onclick = () => { state.scalePick = []; setStatus('Escala: toque em dois pontos da planta com distância conhecida.'); drawPlan(); };
function planDist(a, b) { const c = $('plan'); return Math.hypot((a[0] - b[0]) * c.width, (a[1] - b[1]) * c.height) / c.width; }
function toMeters(pos) { const sc = curFloor()?.scale; if (!sc || !pos) return null; const c = $('plan'); return [pos[0] * sc.mPerUnit, pos[1] * c.height / c.width * sc.mPerUnit]; }

function sizePlan() { const img = state.planImgs[state.floor]; $('plan').height = img ? Math.round($('plan').width * img.height / img.width) : 560; }
function drawPlan() {
  const c = $('plan'); if (!c.offsetParent) return;
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const img = state.planImgs[state.floor];
  if (img) g.drawImage(img, 0, 0, W, H);
  else { g.fillStyle = css('--muted'); g.font = '22px system-ui'; g.fillText('Carregue a planta deste andar ou toque aqui para marcar a posição.', 20, 40); }
  const key = $('metric').value, pts = state.points.filter(p => p.pos && (p.floor ?? state.floors[0]?.id) === state.floor && metricVal(p, key) != null);
  const [lo, hi] = colorLabels(pts.map(p => p[key])), span = hi - lo;
  if (pts.length >= 3) { // interpolação IDW
    const step = 14;
    for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
      let num = 0, den = 0;
      for (const p of pts) { const w = 1 / ((x - p.pos[0] * W) ** 2 + (y - p.pos[1] * H) ** 2 + 1); num += w * p[key]; den += w; }
      g.fillStyle = heat((num / den - lo) / span, 0.35); g.fillRect(x, y, step, step);
    }
  }
  for (const p of pts) drawMarker(g, p.pos[0] * W, p.pos[1] * H, p[key], p.label, lo, span);
  if (state.pos) { const x = state.pos[0] * W, y = state.pos[1] * H; g.strokeStyle = '#000'; g.lineWidth = 3; g.strokeRect(x - 14, y - 14, 28, 28); }
  // barra de escala
  const sc = curFloor()?.scale;
  if (sc) {
    const target = W * 0.25 / W * sc.mPerUnit, nice = niceStep(target, 1), px = nice / sc.mPerUnit * W;
    g.fillStyle = 'rgba(255,255,255,.85)'; g.fillRect(12, H - 46, px + 24, 36);
    g.fillStyle = '#000'; g.fillRect(24, H - 22, px, 5); g.font = 'bold 16px system-ui'; g.fillText(`${nice} m`, 24, H - 28);
  }
  if (state.scalePick?.length === 1) { const [a] = state.scalePick; g.fillStyle = '#d33'; g.beginPath(); g.arc(a[0] * W, a[1] * H, 8, 0, 7); g.fill(); }
  const n = state.points.filter(p => !p.pos).length;
  $('planHint').textContent = (sc ? `Escala: 1 m = ${(W / sc.mPerUnit).toFixed(0)} px. ` : 'Sem escala (toque em Escala para definir). ') + (n ? `${n} ponto(s) só com GPS aparecem na visão GPS.` : '');
}
$('plan').addEventListener('click', async e => {
  const r = e.currentTarget.getBoundingClientRect(), pos = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  if (state.scalePick) {
    state.scalePick.push(pos);
    if (state.scalePick.length === 2) {
      const [a, b] = state.scalePick; state.scalePick = null;
      const m = parseFloat((prompt('Distância real entre os dois pontos, em metros:') || '').replace(',', '.'));
      if (m > 0) { curFloor().scale = { mPerUnit: m / planDist(a, b) }; await saveFloors(); setStatus(`Escala definida: ${m} m.`); }
      else setStatus('Escala cancelada.');
    }
    drawPlan(); return;
  }
  state.pos = pos;
  const mm = toMeters(pos);
  $('xy').value = mm ? `${mm[0].toFixed(1)} m, ${mm[1].toFixed(1)} m` : pos.map(v => v.toFixed(3)).join(', ');
  drawPlan();
  setStatus('Posição marcada. Toque em Coletar.');
});
function loadImg(blob) { return new Promise(res => { if (!blob) return res(null); const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = URL.createObjectURL(blob); }); }
$('planFile').onchange = async e => {
  const blob = e.target.files[0]; if (!blob) return;
  state.planImgs[state.floor] = await loadImg(blob); await save('plan:' + state.floor, blob);
  sizePlan(); drawPlan();
};

// ---------- Mapa GPS (OpenStreetMap) ----------
const tileCache = {};
function tile(z, x, y) {
  const k = `${z}/${x}/${y}`;
  if (!tileCache[k]) { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => drawGps(); img.src = `https://tile.openstreetmap.org/${k}.png`; tileCache[k] = img; }
  return tileCache[k];
}
const lon2x = (lon, z) => (lon + 180) / 360 * 256 * 2 ** z;
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 256 * 2 ** z; };
function drawGps() {
  const c = $('gpsMap'); if (!c.offsetParent) return;
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.fillStyle = css('--bg'); g.fillRect(0, 0, W, H);
  const key = $('metric').value, pts = state.points.filter(p => p.gps);
  if (!pts.length) { g.fillStyle = css('--muted'); g.font = '22px system-ui'; g.fillText('Nenhum ponto com GPS ainda. Marque "Pegar GPS" na aba Medir.', 20, 40); return; }
  const lats = pts.map(p => p.gps.lat), lons = pts.map(p => p.gps.lon);
  const cLat = (Math.min(...lats) + Math.max(...lats)) / 2, cLon = (Math.min(...lons) + Math.max(...lons)) / 2;
  let z = 19;
  while (z > 3 && (lon2x(Math.max(...lons), z) - lon2x(Math.min(...lons), z) > W * 0.8 || lat2y(Math.min(...lats), z) - lat2y(Math.max(...lats), z) > H * 0.8)) z--;
  const ox = lon2x(cLon, z) - W / 2, oy = lat2y(cLat, z) - H / 2;
  if (navigator.onLine) {
    for (let tx = Math.floor(ox / 256); tx <= Math.floor((ox + W) / 256); tx++)
      for (let ty = Math.floor(oy / 256); ty <= Math.floor((oy + H) / 256); ty++) {
        const img = tile(z, tx, ty);
        if (img.complete && img.naturalWidth) g.drawImage(img, tx * 256 - ox, ty * 256 - oy);
      }
  }
  const vals = pts.map(p => metricVal(p, key)).filter(v => v != null), [lo, hi] = colorLabels(vals), span = hi - lo;
  for (const p of pts) drawMarker(g, lon2x(p.gps.lon, z) - ox, lat2y(p.gps.lat, z) - oy, metricVal(p, key), p.label, lo, span);
  g.font = '12px system-ui'; g.fillStyle = 'rgba(255,255,255,.8)'; g.fillRect(W - 190, H - 20, 190, 20); g.fillStyle = '#333'; g.fillText('© OpenStreetMap contributors', W - 184, H - 6);
}
$('mapView').onchange = () => {
  const gps = $('mapView').value === 'gps';
  $('planBox').style.display = gps ? 'none' : ''; $('gpsBox').style.display = gps ? '' : 'none';
  drawPlan(); drawGps(); saveSettings();
};

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const floorName = id => state.floors.find(f => f.id === id)?.name ?? '';
function drawTable() {
  const key = $('metric').value;
  $('count').textContent = state.points.length;
  $('tbl').innerHTML = state.points.slice().reverse().map(p => `<tr><td>${p.id}</td><td>${esc(p.label)}</td><td>${p.time.slice(11, 19)}</td><td>${p.max.toFixed(1)}</td><td>${(p.fmax / 1e6).toFixed(3)}</td><td>${fmtV(metricVal(p, key))}</td><td>${esc(p.pos ? floorName(p.floor ?? state.floors[0]?.id) : '')}</td><td>${p.gps ? '✓' : ''}</td><td><a href="#" data-del="${p.id}">apagar</a></td></tr>`).join('');
}
$('tbl').onclick = async e => {
  const id = +e.target.dataset.del; if (!id) return;
  e.preventDefault();
  if (!confirm('Apagar o ponto ' + id + '?')) return;
  state.points = state.points.filter(p => p.id !== id);
  await save('points', state.points); drawPlan(); drawGps(); drawTable();
};
function drawAll() { drawSpectrum(); drawWaterfall(); drawPlan(); drawGps(); drawTable(); }
addEventListener('resize', () => requestAnimationFrame(drawAll));
$('metric').onchange = () => { drawPlan(); drawGps(); drawTable(); saveSettings(); };
for (const id of ['lo', 'hi']) $(id).addEventListener('input', () => { drawPlan(); drawGps(); saveSettings(); });

// ---------- Exportação / sessão ----------
function downloadBlob(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }
const download = (name, text, type) => downloadBlob(name, new Blob([text], { type }));
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
$('btnCsv').onclick = () => {
  const head = 'id,label,time,device,input,floor,x,y,x_m,y_m,lat,lon,gps_acc_m,start_mhz,stop_mhz,points,average,rbw_khz,att_db,offset_db,peak_dbm,peak_hz,mean_dbm,chpow_dbm,ch_mhz,ch_bw_khz,ch_dbm,m1_mhz,m1_dbm,m2_mhz,m2_dbm,m3_mhz,m3_dbm,m4_mhz,m4_dbm';
  const rows = state.points.map(p => {
    const fl = state.floors.find(f => f.id === (p.floor ?? state.floors[0]?.id));
    return [p.id, JSON.stringify(p.label), p.time, p.device, p.input, p.pos ? JSON.stringify(fl?.name ?? '') : '', p.pos?.[0] ?? '', p.pos?.[1] ?? '', p.xm?.toFixed(2) ?? '', p.ym?.toFixed(2) ?? '',
      p.gps?.lat ?? '', p.gps?.lon ?? '', p.gps?.acc ?? '', p.startMHz, p.stopMHz, p.points, p.average, p.rbw ?? 'auto', p.att ?? 'auto', p.offset ?? 0,
      p.max.toFixed(2), p.fmax, p.mean.toFixed(2), p.chpow.toFixed(2), p.chMHz ?? '', p.chMHz != null ? p.chBwKHz : '', p.ch != null ? p.ch.toFixed(2) : '',
      ...[1, 2, 3, 4].flatMap(k => p['m' + k] != null ? [(p['m' + k + 'f'] / 1e6).toFixed(4), p['m' + k].toFixed(2)] : ['', ''])].join(',');
  });
  download(`survey-${stamp()}.csv`, [head, ...rows].join('\n'), 'text/csv');
};
$('btnJson').onclick = () => download(`survey-${stamp()}.json`, JSON.stringify({ app: 'site-survey-rf', version: 3, floors: state.floors.map(({ id, name, scale }) => ({ id, name, scale })), points: state.points }), 'application/json');
$('fileLoad').onchange = async e => {
  try {
    const d = JSON.parse(await e.target.files[0].text());
    state.points = d.points || [];
    for (const f of d.floors || []) if (!state.floors.some(x => x.id === f.id)) state.floors.push(f);
    showFloors(); await saveFloors();
    await save('points', state.points); drawPlan(); drawGps(); drawTable();
  } catch (err) { setStatus('Arquivo inválido: ' + err.message, 'bad'); }
};
$('btnClear').onclick = async () => {
  if (state.points.length && !confirm('Começar uma nova sessão? Exporte antes: os pontos atuais serão apagados do aparelho.')) return;
  state.points = []; state.pos = null; $('xy').value = '';
  await save('points', []); drawPlan(); drawGps(); drawTable();
};

// PNG: o espectro como está na tela; o mapa na visão atual
function canvasPng(c, name) {
  try { c.toBlob(b => b ? downloadBlob(name, b) : setStatus('Não foi possível gerar a imagem.', 'bad'), 'image/png'); }
  catch (_) { setStatus('O mapa de rua não pode ser exportado como imagem; use a visão Planta.', 'bad'); }
}
$('btnPngSpec').onclick = () => { showTab('medir'); requestAnimationFrame(() => canvasPng($('spec'), `espectro-${stamp()}.png`)); };
$('btnPngMap').onclick = () => { showTab('mapa'); requestAnimationFrame(() => canvasPng($('mapView').value === 'gps' ? $('gpsMap') : $('plan'), `mapa-${stamp()}.png`)); };

// Relatório: página para imprimir ou salvar como PDF, com mapa por andar, tabela e o espectro de cada ponto
function miniSpectrum(p, w = 520, h = 150) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'), lo = Math.floor(Math.min(...p.dbm) / 10) * 10, hi = Math.ceil(Math.max(...(p.maxhold || p.dbm)) / 10) * 10 + 5;
  const X = i => 40 + i / (p.dbm.length - 1) * (w - 50), Y = v => 10 + (hi - v) / (hi - lo) * (h - 30);
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.strokeStyle = '#ddd'; g.fillStyle = '#555'; g.font = '10px sans-serif';
  for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) { g.beginPath(); g.moveTo(40, Y(v)); g.lineTo(w - 10, Y(v)); g.stroke(); g.fillText(v, 6, Y(v) + 3); }
  g.fillText(`${p.startMHz} MHz`, 40, h - 6); g.textAlign = 'right'; g.fillText(`${p.stopMHz} MHz`, w - 10, h - 6);
  const line = (arr, col) => { g.strokeStyle = col; g.lineWidth = 1.3; g.beginPath(); arr.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))); g.stroke(); };
  if (p.maxhold) line(p.maxhold, '#d4760a');
  line(p.dbm, '#1f6feb');
  return c.toDataURL('image/png');
}
$('btnReport').onclick = () => {
  if (!state.points.length) { setStatus('Nenhum ponto para o relatório.', 'bad'); return; }
  const key = $('metric').value, keyName = $('metric').selectedOptions[0].text;
  const view = $('mapView').value, saveFloor = state.floor, savePos = state.pos;
  showTab('mapa'); $('mapView').value = 'plan'; $('mapView').onchange(); state.pos = null;
  const maps = [];
  for (const f of state.floors) {
    if (!state.points.some(p => p.pos && (p.floor ?? state.floors[0].id) === f.id)) continue;
    state.floor = f.id; sizePlan(); drawPlan();
    try { maps.push(`<h2>Mapa — ${esc(f.name)}</h2><img src="${$('plan').toDataURL('image/png')}">`); } catch (_) {}
  }
  state.floor = saveFloor; state.pos = savePos; sizePlan(); $('mapView').value = view; $('mapView').onchange();
  const p0 = state.points[0];
  const rows = state.points.map(p => `<tr><td>${p.id}</td><td>${esc(p.label)}</td><td>${new Date(p.time).toLocaleString('pt-BR')}</td><td>${esc(p.pos ? floorName(p.floor ?? state.floors[0]?.id) : '')}</td><td>${p.gps ? `${p.gps.lat.toFixed(5)}, ${p.gps.lon.toFixed(5)}` : ''}</td><td>${p.max.toFixed(1)}</td><td>${(p.fmax / 1e6).toFixed(3)}</td><td>${fmtV(metricVal(p, key))}</td></tr>`).join('');
  const specs = state.points.map(p => `<div class="sp"><b>${esc(p.label)}</b> — pico ${p.max.toFixed(1)} dBm em ${(p.fmax / 1e6).toFixed(3)} MHz<br><img src="${miniSpectrum(p)}"></div>`).join('');
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Relatório de site survey</title><style>
    body{font:13px/1.4 system-ui,sans-serif;color:#111;margin:24px} h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:20px 0 8px}
    table{border-collapse:collapse;width:100%;font-size:12px} td,th{border-bottom:1px solid #ccc;padding:4px;text-align:left}
    img{max-width:100%} .sp{display:inline-block;width:48%;margin:0 1% 12px 0;vertical-align:top;break-inside:avoid} .meta{color:#555}
    @media print{button{display:none}}</style></head><body>
    <button onclick="print()">Imprimir / salvar PDF</button>
    <h1>Relatório de site survey RF</h1>
    <div class="meta">Gerado em ${new Date().toLocaleString('pt-BR')} · ${state.points.length} pontos · ${esc(state.device?.name || '')} · faixa ${p0.startMHz}–${p0.stopMHz} MHz · métrica do mapa: ${esc(keyName)}</div>
    ${maps.join('')}
    <h2>Pontos</h2><table><thead><tr><th>#</th><th>Nome</th><th>Data/hora</th><th>Andar</th><th>GPS</th><th>Pico dBm</th><th>Freq. pico MHz</th><th>${esc(keyName)}</th></tr></thead><tbody>${rows}</tbody></table>
    <h2>Espectro de cada ponto</h2><div>${specs}</div>
    <p class="meta">Azul: média das leituras do ponto. Laranja: max hold.</p></body></html>`;
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); setTimeout(() => w.print(), 600); }
  else downloadBlob(`relatorio-${stamp()}.html`, new Blob([html], { type: 'text/html' }));
};

// ---------- Atualização ----------
// O app aberto por horas não pega versões novas sozinho: compara a versão publicada do sw.js e oferece recarregar
async function swVersion() { try { return (await (await fetch('sw.js', { cache: 'no-store' })).text()).match(/VERSION = '([^']+)'/)?.[1]; } catch (_) { return null; } }
async function watchUpdates() {
  const mine = await swVersion(); if (!mine) return;
  const check = async () => { const v = await swVersion(); if (v && v !== mine) $('updBanner').hidden = false; };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  setInterval(check, 10 * 60 * 1000);
}
$('updBanner').onclick = () => location.reload();

// ---------- Configurações ----------
function saveSettings() { save('settings', { ...params(), device: $('device').value, autoGps: $('autoGps').checked, lo: $('lo').value, hi: $('hi').value, metric: $('metric').value, mapView: $('mapView').value, autoSec: $('autoSec').value, limDbm: $('limDbm').value, limAlarm: $('limAlarm').classList.contains('on') }); }

(async function init() {
  const s = await load('settings');
  if (s) {
    $('device').value = s.device ?? 0;
    selectDevice(); setParams(s);
    $('autoGps').checked = !!s.autoGps; $('lo').value = s.lo ?? ''; $('hi').value = s.hi ?? '';
    if (s.metric) $('metric').value = s.metric; if (s.mapView) $('mapView').value = s.mapView; if (s.autoSec) $('autoSec').value = s.autoSec;
    $('limDbm').value = s.limDbm ?? ''; $('limAlarm').classList.toggle('on', !!s.limAlarm);
  }
  selectDevice();
  state.points = (await load('points')) || [];
  state.profiles = (await load('profiles')) || []; showProfiles();
  const mk = await load('markers');
  if (mk) { state.markers = mk.list || []; state.mkActive = mk.active || 0; state.mkDelta = !!mk.delta; }
  showMarkerBar();
  // andares: migra a planta única das versões anteriores para o "Andar 1"
  state.floors = (await load('floors')) || [];
  if (!state.floors.length) {
    state.floors = [{ id: 1, name: 'Andar 1', scale: null }];
    const old = await load('plan'); if (old) await save('plan:1', old);
  }
  state.floor = (await load('floorCur')) ?? state.floors[0].id;
  if (!state.floors.some(f => f.id === state.floor)) state.floor = state.floors[0].id;
  for (const f of state.floors) state.planImgs[f.id] = await loadImg(await load('plan:' + f.id));
  await saveFloors(); showFloors(); sizePlan();
  $('mapView').onchange();
  drawAll();
  if (state.points.length) log(`sessão restaurada: ${state.points.length} pontos`);
  if (!('serial' in navigator)) log(('usb' in navigator) ? 'Web Serial indisponível; será usado WebUSB.' : 'Navegador sem Web Serial e sem WebUSB.');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => log('service worker: ' + e.message));
  watchUpdates();
})();
