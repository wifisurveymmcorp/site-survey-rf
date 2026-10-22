import { DEVICES } from './devices/index.js';
import { save, load } from './store.js';

const $ = id => document.getElementById(id);

const APP_VERSION = '0.5';
const CHANGELOG = [
  ['0.5', 'Nova interface em abas (Medir, Mapa, Dados); modo ao vivo com traços atual, média e max hold; waterfall; pico marcado e leitura ao tocar no gráfico; legenda de cores com limites; reconecta sem pedir para escolher o aparelho de novo.'],
  ['0.4', 'Tela de Ajuda, aviso de espectro plano (antena), indicador online/offline.'],
  ['0.3', 'Testado com TinySA Basic real no Android: conexão por WebUSB, correção das respostas atrasadas, atualizações chegam na hora.'],
  ['0.2', 'App instalável no Android, funciona offline, sessão salva no celular, faixas prontas do Basic (inclui TETRA 380–430 MHz).'],
  ['0.1', 'Protótipo: varredura, marcação na planta e GPS, mapa de calor, exportação CSV/JSON.'],
];
const WF_ROWS = 120;

const state = {
  device: null, connected: false, pos: null, gps: null, points: [], planImg: null, planBlob: null,
  live: false, busy: false,          // busy = uma varredura em andamento (ao vivo ou coleta)
  trace: null,                       // { freqs, cur, avg, max, n, startMHz, stopMHz, key }
  wf: [],                            // linhas do waterfall (dBm), a mais nova primeiro
  cursor: null,                      // índice tocado no gráfico
};

// ---------- Log ----------
function log(s) {
  const el = $('log');
  el.textContent += `[${new Date().toLocaleTimeString()}] ${s}\n`;
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
  return { startMHz: +$('fStart').value, stopMHz: +$('fStop').value, points: Math.max(2, Math.min(450, +$('pts').value | 0)), average: Math.max(1, +$('avg').value | 0) };
}
function checkParams() {
  const p = params(), c = state.device.check(p);
  $('hint').textContent = c.hint; $('hint').className = 'status ' + (c.ok ? '' : 'bad');
  const name = $('preset').selectedOptions[0]?.value ? $('preset').selectedOptions[0].text : `${p.startMHz}–${p.stopMHz} MHz`;
  $('sweepSummary').textContent = name;
  return c.ok;
}
function syncPreset() {
  const v = `${+$('fStart').value},${+$('fStop').value}`;
  $('preset').value = [...$('preset').options].some(o => o.value === v) ? v : '';
}
$('preset').onchange = () => { const v = $('preset').value; if (!v) return; [$('fStart').value, $('fStop').value] = v.split(','); checkParams(); saveSettings(); };
for (const id of ['fStart', 'fStop', 'pts', 'avg']) $(id).addEventListener('input', () => { syncPreset(); checkParams(); saveSettings(); });

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    else { await wakeLock?.release(); wakeLock = null; }
  } catch (_) {}
}
document.addEventListener('visibilitychange', () => { if (state.connected && document.visibilityState === 'visible') keepAwake(true); });

function setConnected(on, text) {
  state.connected = on;
  $('dot').classList.toggle('on', on);
  $('connText').textContent = text;
  $('btnConnect').disabled = on; $('btnDisconnect').disabled = !on; $('device').disabled = on;
  $('btnCapture').disabled = !on; $('btnLive').disabled = !on;
}

$('btnConnect').onclick = async () => {
  $('btnConnect').disabled = true;
  log(`diagnóstico: ${navigator.userAgent} | Web Serial: ${'serial' in navigator ? 'sim' : 'não'} | WebUSB: ${'usb' in navigator ? 'sim' : 'não'} | conexão: ${$('transport').value}`);
  try {
    const v = await state.device.connect({ log, prefer: $('transport').value });
    setConnected(true, v); log('conectado: ' + v);
    $('cfgDev').open = false;
    setStatus('Ligue o Ao vivo para acompanhar o sinal, ou toque em Coletar.');
    keepAwake(true);
  } catch (e) {
    $('btnConnect').disabled = false;
    $('connText').textContent = 'erro ao conectar'; setStatus(e.message, 'bad'); log('falha ao conectar: ' + e.message);
  }
};
$('btnDisconnect').onclick = async () => {
  setLive(false);
  while (state.busy) await new Promise(r => setTimeout(r, 100));
  await state.device.disconnect();
  setConnected(false, 'desconectado'); keepAwake(false);
};

// ---------- Traços (atual, média, max hold) e waterfall ----------
function traceKey(p) { return `${p.startMHz}|${p.stopMHz}|${p.points}`; }
function resetTrace() { state.trace = null; state.wf = []; state.cursor = null; drawSpectrum(); drawWaterfall(); }
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

// Uma varredura por vez: o modo ao vivo e a coleta compartilham o dispositivo
async function sweepOnce(p) {
  while (state.busy) await new Promise(r => setTimeout(r, 50));
  state.busy = true;
  try { return await state.device.sweep(p, { pos: state.pos }); }
  finally { state.busy = false; }
}

let capturing = false;
async function liveLoop() {
  while (state.live && state.connected) {
    if (capturing || !checkParams()) { await new Promise(r => setTimeout(r, 200)); continue; }
    const p = params(), t0 = performance.now();
    try {
      const s = await sweepOnce(p);
      addSweep(p, s);
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
function metrics(f, p) {
  let iMax = 0; for (let i = 1; i < p.length; i++) if (p[i] > p[iMax]) iMax = i;
  const sum = p.reduce((a, v) => a + Math.pow(10, v / 10), 0);
  return { max: p[iMax], fmax: f[iMax], mean: 10 * Math.log10(sum / p.length), chpow: 10 * Math.log10(sum) };
}

$('btnCapture').onclick = async () => {
  if (!checkParams()) { setStatus('Ajuste a faixa antes de coletar.', 'bad'); return; }
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
    const m = metrics(freqs, dbm);
    const rec = {
      id: (state.points.at(-1)?.id || 0) + 1, label: $('label').value.trim(), time: new Date().toISOString(),
      device: state.device.id, input, pos: state.pos, gps: state.gps, ...prm, freqs, dbm, maxhold: maxHold, ...m,
    };
    rec.label ||= 'P' + rec.id;
    state.points.push(rec);
    setStatus(`${rec.label}: pico ${m.max.toFixed(1)} dBm em ${(m.fmax / 1e6).toFixed(3)} MHz`);
    const flat = flatHint(dbm, rec.input);
    if (flat) { setStatus($('capStatus').textContent + ' — ' + flat, 'warn'); log('aviso: ' + flat); }
    if (navigator.vibrate) navigator.vibrate(80);
    $('label').value = '';
    await save('points', state.points);
    drawPlan(); drawTable();
  } catch (e) { setStatus('Erro: ' + e.message, 'bad'); log('erro na coleta: ' + e.message); }
  capturing = false;
  $('btnCapture').disabled = !state.connected;
};

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
  if (!t) { g.fillText(state.connected ? 'Toque em Ao vivo ou Coletar para ver o espectro.' : 'Conecte o TinySA para ver o espectro.', 12, 24); return; }
  const all = [...t.max, ...t.cur];
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
  // traços
  const line = (arr, color, width) => { g.strokeStyle = color; g.lineWidth = width; g.beginPath(); arr.forEach((v, i) => i ? g.lineTo(X(t.freqs[i]), Y(v)) : g.moveTo(X(t.freqs[i]), Y(v))); g.stroke(); };
  line(t.max, css('--tr-max'), 1.2);
  line(t.avg, css('--tr-avg'), 1.2);
  line(t.cur, css('--tr-live'), 1.6);
  // pico do max hold
  let ip = 0; t.max.forEach((v, i) => { if (v > t.max[ip]) ip = i; });
  const px = X(t.freqs[ip]), py = Y(t.max[ip]);
  g.fillStyle = css('--tr-max'); g.beginPath(); g.moveTo(px, py - 3); g.lineTo(px - 5, py - 11); g.lineTo(px + 5, py - 11); g.fill();
  g.font = '600 11px system-ui'; g.textAlign = px > w - 120 ? 'right' : 'left';
  g.fillStyle = css('--fg'); g.fillText(`pico ${t.max[ip].toFixed(1)} dBm · ${fmtMHz(t.freqs[ip])} MHz`, px + (g.textAlign === 'left' ? 8 : -8), Math.max(12, py - 12));
  // cursor tocado
  if (state.cursor != null && state.cursor < t.freqs.length) {
    const i = state.cursor, cx = X(t.freqs[i]);
    g.strokeStyle = css('--fg'); g.setLineDash([4, 3]); g.lineWidth = 1; g.beginPath(); g.moveTo(cx, P.t); g.lineTo(cx, h - P.b); g.stroke(); g.setLineDash([]);
    $('readout').textContent = `${fmtMHz(t.freqs[i])} MHz — atual ${t.cur[i].toFixed(1)} · média ${t.avg[i].toFixed(1)} · max ${t.max[i].toFixed(1)} dBm`;
  } else $('readout').textContent = 'Toque no gráfico para ler um valor.';
}
function specIndexAt(clientX) {
  const t = state.trace; if (!t) return null;
  const r = $('spec').getBoundingClientRect(), x = clientX - r.left;
  const frac = (x - SPEC_PAD.l) / (r.width - SPEC_PAD.l - SPEC_PAD.r);
  return Math.max(0, Math.min(t.freqs.length - 1, Math.round(frac * (t.freqs.length - 1))));
}
$('spec').addEventListener('pointerdown', e => { state.cursor = specIndexAt(e.clientX); drawSpectrum(); $('spec').setPointerCapture(e.pointerId); });
$('spec').addEventListener('pointermove', e => { if (e.buttons) { state.cursor = specIndexAt(e.clientX); drawSpectrum(); } });

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
function drawPlan() {
  const c = $('plan'); if (!c.offsetParent) return;
  const g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (state.planImg) g.drawImage(state.planImg, 0, 0, W, H);
  else { g.fillStyle = css('--muted'); g.font = '22px system-ui'; g.fillText('Carregue a planta ou toque aqui para marcar a posição.', 20, 40); }
  const key = $('metric').value, pts = state.points.filter(p => p.pos);
  const [lo, hi] = pts.length ? scaleRange(pts.map(p => p[key])) : [NaN, NaN];
  $('loLbl').textContent = isFinite(lo) ? lo.toFixed(0) + ' dBm' : ''; $('hiLbl').textContent = isFinite(hi) ? hi.toFixed(0) + ' dBm' : '';
  if (pts.length) {
    const span = hi - lo;
    if (pts.length >= 3) { // interpolação IDW
      const step = 14;
      for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
        let num = 0, den = 0;
        for (const p of pts) { const w = 1 / ((x - p.pos[0] * W) ** 2 + (y - p.pos[1] * H) ** 2 + 1); num += w * p[key]; den += w; }
        g.fillStyle = heat((num / den - lo) / span, 0.35); g.fillRect(x, y, step, step);
      }
    }
    g.font = 'bold 20px system-ui';
    for (const p of pts) {
      const x = p.pos[0] * W, y = p.pos[1] * H;
      g.fillStyle = heat((p[key] - lo) / span, 1); g.beginPath(); g.arc(x, y, 11, 0, 7); g.fill();
      g.strokeStyle = '#000'; g.lineWidth = 2; g.stroke();
      const t = `${p.label} ${p[key].toFixed(1)}`;
      g.lineWidth = 4; g.strokeStyle = '#fff'; g.strokeText(t, x + 14, y - 8); g.fillStyle = '#000'; g.fillText(t, x + 14, y - 8);
    }
  }
  if (state.pos) { const x = state.pos[0] * W, y = state.pos[1] * H; g.strokeStyle = '#000'; g.lineWidth = 3; g.strokeRect(x - 14, y - 14, 28, 28); }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
function drawTable() {
  const key = $('metric').value;
  $('count').textContent = state.points.length;
  $('tbl').innerHTML = state.points.slice().reverse().map(p => `<tr><td>${p.id}</td><td>${esc(p.label)}</td><td>${p.time.slice(11, 19)}</td><td>${p.max.toFixed(1)}</td><td>${(p.fmax / 1e6).toFixed(3)}</td><td>${p[key].toFixed(1)}</td><td>${p.gps ? '✓' : ''}</td><td><a href="#" data-del="${p.id}">apagar</a></td></tr>`).join('');
}
$('tbl').onclick = async e => {
  const id = +e.target.dataset.del; if (!id) return;
  e.preventDefault();
  if (!confirm('Apagar o ponto ' + id + '?')) return;
  state.points = state.points.filter(p => p.id !== id);
  await save('points', state.points); drawPlan(); drawTable();
};
function drawAll() { drawSpectrum(); drawWaterfall(); drawPlan(); drawTable(); }
addEventListener('resize', () => requestAnimationFrame(drawAll));
$('metric').onchange = () => { drawPlan(); drawTable(); };
for (const id of ['lo', 'hi']) $(id).addEventListener('input', () => { drawPlan(); saveSettings(); });

$('plan').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  state.pos = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  $('xy').value = state.pos.map(v => v.toFixed(3)).join(', ');
  drawPlan();
  setStatus('Posição marcada. Volte em Medir ou toque em Coletar.');
});
async function setPlan(blob) {
  if (!blob) return;
  const img = new Image();
  img.onload = () => { state.planImg = img; $('plan').height = Math.round($('plan').width * img.height / img.width); drawPlan(); };
  img.src = URL.createObjectURL(blob);
  state.planBlob = blob;
}
$('planFile').onchange = async e => { await setPlan(e.target.files[0]); save('plan', state.planBlob); };

// ---------- Exportação / sessão ----------
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); }
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
$('btnCsv').onclick = () => {
  const head = 'id,label,time,device,input,x,y,lat,lon,gps_acc_m,start_mhz,stop_mhz,points,average,peak_dbm,peak_hz,mean_dbm,chpow_dbm';
  const rows = state.points.map(p => [p.id, JSON.stringify(p.label), p.time, p.device, p.input, p.pos?.[0] ?? '', p.pos?.[1] ?? '', p.gps?.lat ?? '', p.gps?.lon ?? '', p.gps?.acc ?? '',
    p.startMHz, p.stopMHz, p.points, p.average, p.max.toFixed(2), p.fmax, p.mean.toFixed(2), p.chpow.toFixed(2)].join(','));
  download(`survey-${stamp()}.csv`, [head, ...rows].join('\n'), 'text/csv');
};
$('btnJson').onclick = () => download(`survey-${stamp()}.json`, JSON.stringify({ app: 'site-survey-rf', version: 2, points: state.points }), 'application/json');
$('fileLoad').onchange = async e => {
  try {
    const d = JSON.parse(await e.target.files[0].text());
    state.points = d.points || [];
    await save('points', state.points); drawPlan(); drawTable();
  } catch (err) { setStatus('Arquivo inválido: ' + err.message, 'bad'); }
};
$('btnClear').onclick = async () => {
  if (state.points.length && !confirm('Começar uma nova sessão? Exporte antes: os pontos atuais serão apagados do aparelho.')) return;
  state.points = []; state.pos = null; $('xy').value = '';
  await save('points', []); drawPlan(); drawTable();
};

// ---------- Configurações ----------
function saveSettings() { save('settings', { ...params(), device: $('device').value, autoGps: $('autoGps').checked, lo: $('lo').value, hi: $('hi').value }); }

(async function init() {
  const s = await load('settings');
  if (s) {
    $('device').value = s.device ?? 0;
    $('fStart').value = s.startMHz; $('fStop').value = s.stopMHz; $('pts').value = s.points; $('avg').value = s.average;
    $('autoGps').checked = !!s.autoGps; $('lo').value = s.lo ?? ''; $('hi').value = s.hi ?? '';
  }
  selectDevice();
  state.points = (await load('points')) || [];
  await setPlan(await load('plan'));
  drawAll();
  if (state.points.length) log(`sessão restaurada: ${state.points.length} pontos`);
  if (!('serial' in navigator)) log(('usb' in navigator) ? 'Web Serial indisponível; será usado WebUSB.' : 'Navegador sem Web Serial e sem WebUSB.');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => log('service worker: ' + e.message));
})();
