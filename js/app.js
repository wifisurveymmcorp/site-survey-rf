import { DEVICES } from './devices/index.js';
import { save, load } from './store.js';

const $ = id => document.getElementById(id);
const state = { device: null, connected: false, pos: null, gps: null, points: [], planImg: null, planBlob: null, lastScan: null };

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

function setStatus(s, bad = false) { $('capStatus').textContent = s; $('capStatus').classList.toggle('bad', bad); }

// ---------- Dispositivo ----------
$('device').innerHTML = DEVICES.map((d, i) => `<option value="${i}">${d.name}</option>`).join('');
function selectDevice() {
  const d = state.device = DEVICES[+$('device').value];
  $('preset').innerHTML = '<option value="">— personalizada —</option>' +
    d.bands.map(([n, a, b]) => `<option value="${a},${b}">${n}</option>`).join('');
  for (const [k, id] of [['startMHz', 'fStart'], ['stopMHz', 'fStop'], ['points', 'pts'], ['average', 'avg']])
    if (!$(id).value) $(id).value = d.defaults[k];
  syncPreset(); checkParams();
}
$('device').onchange = selectDevice;

function params() {
  return { startMHz: +$('fStart').value, stopMHz: +$('fStop').value, points: Math.max(2, Math.min(450, +$('pts').value | 0)), average: Math.max(1, +$('avg').value | 0) };
}
function checkParams() {
  const c = state.device.check(params());
  $('hint').textContent = c.hint; $('hint').classList.toggle('bad', !c.ok);
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

$('btnConnect').onclick = async () => {
  $('btnConnect').disabled = true;
  log(`diagnóstico: ${navigator.userAgent} | Web Serial: ${'serial' in navigator ? 'sim' : 'não'} | WebUSB: ${'usb' in navigator ? 'sim' : 'não'} | conexão: ${$('transport').value}`);
  try {
    const v = await state.device.connect({ log, prefer: $('transport').value });
    state.connected = true;
    $('conn').textContent = 'conectado: ' + v; log('conectado: ' + v);
    $('btnDisconnect').disabled = false; $('device').disabled = true; $('btnCapture').disabled = false;
    setStatus('Marque a posição na planta e toque em Coletar.');
    keepAwake(true);
  } catch (e) {
    $('btnConnect').disabled = false;
    $('conn').textContent = 'erro ao conectar'; setStatus(e.message, true); log('falha ao conectar: ' + e.message);
  }
};
$('btnDisconnect').onclick = async () => {
  await state.device.disconnect();
  state.connected = false; keepAwake(false);
  $('conn').textContent = 'desconectado';
  $('btnConnect').disabled = false; $('btnDisconnect').disabled = true; $('device').disabled = false; $('btnCapture').disabled = true;
};

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
  if (!checkParams()) { setStatus('Ajuste a faixa antes de coletar.', true); return; }
  const prm = params();
  $('btnCapture').disabled = true;
  try {
    const gpsP = $('autoGps').checked ? getGps() : Promise.resolve(state.gps);
    let acc = null, freqs, input;
    for (let k = 0; k < prm.average; k++) {
      setStatus(`Varrendo ${k + 1}/${prm.average}…`);
      const s = await state.device.sweep(prm, { pos: state.pos });
      freqs = s.freqs; input = s.input;
      const lin = s.dbm.map(v => Math.pow(10, v / 10));
      acc = acc ? acc.map((v, i) => v + (lin[i] ?? 0)) : lin;
    }
    const dbm = acc.map(v => 10 * Math.log10(v / prm.average));
    state.gps = await gpsP; showGps();
    const m = metrics(freqs, dbm);
    const rec = {
      id: (state.points.at(-1)?.id || 0) + 1, label: $('label').value.trim(), time: new Date().toISOString(),
      device: state.device.id, input, pos: state.pos, gps: state.gps, ...prm, freqs, dbm, ...m,
    };
    rec.label ||= 'P' + rec.id;
    state.points.push(rec); state.lastScan = rec;
    setStatus(`${rec.label}: pico ${m.max.toFixed(1)} dBm em ${(m.fmax / 1e6).toFixed(3)} MHz`);
    if (navigator.vibrate) navigator.vibrate(80);
    $('label').value = '';
    await save('points', state.points);
    drawAll();
  } catch (e) { setStatus('Erro: ' + e.message, true); log('erro na coleta: ' + e.message); }
  $('btnCapture').disabled = !state.connected;
};

// ---------- Desenho ----------
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function drawSpectrum() {
  const c = $('spec'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const s = state.lastScan;
  g.font = '20px system-ui'; g.fillStyle = css('--muted');
  if (!s) { g.fillText('Nenhuma leitura ainda.', 20, 40); return; }
  const lo = Math.floor(Math.min(...s.dbm) / 10) * 10, hi = Math.ceil(Math.max(...s.dbm) / 10) * 10 + 10;
  const X = i => 60 + i / (s.dbm.length - 1) * (W - 70), Y = v => H - 30 - (v - lo) / (hi - lo) * (H - 45);
  g.strokeStyle = css('--line'); g.lineWidth = 1;
  for (let v = lo; v <= hi; v += 10) { g.beginPath(); g.moveTo(60, Y(v)); g.lineTo(W - 10, Y(v)); g.stroke(); g.fillText(v, 6, Y(v) + 6); }
  g.fillText((s.startMHz).toFixed(1) + ' MHz', 60, H - 6);
  const t = (s.stopMHz).toFixed(1) + ' MHz'; g.fillText(t, W - 10 - g.measureText(t).width, H - 6);
  g.strokeStyle = css('--acc'); g.lineWidth = 2; g.beginPath();
  s.dbm.forEach((v, i) => i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)));
  g.stroke();
}
const heat = (t, a) => `hsla(${(1 - Math.max(0, Math.min(1, t))) * 240},85%,50%,${a})`;
function drawPlan() {
  const c = $('plan'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  if (state.planImg) g.drawImage(state.planImg, 0, 0, W, H);
  else { g.fillStyle = css('--muted'); g.font = '22px system-ui'; g.fillText('Carregue a planta ou toque aqui para marcar a posição.', 20, 40); }
  const key = $('metric').value, pts = state.points.filter(p => p.pos);
  if (pts.length) {
    const vals = pts.map(p => p[key]), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
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
  $('tbl').innerHTML = state.points.slice().reverse().map(p => `<tr><td>${p.id}</td><td>${esc(p.label)}</td><td>${p.time.slice(11, 19)}</td><td>${p.max.toFixed(1)}</td><td>${(p.fmax / 1e6).toFixed(3)}</td><td>${p[key].toFixed(1)}</td><td><a href="#" data-del="${p.id}">apagar</a></td></tr>`).join('');
}
$('tbl').onclick = async e => {
  const id = +e.target.dataset.del; if (!id) return;
  e.preventDefault();
  if (!confirm('Apagar o ponto ' + id + '?')) return;
  state.points = state.points.filter(p => p.id !== id); state.lastScan = state.points.at(-1) || null;
  await save('points', state.points); drawAll();
};
function drawAll() { drawSpectrum(); drawPlan(); drawTable(); }
$('metric').onchange = drawAll;

$('plan').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  state.pos = [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  $('xy').value = state.pos.map(v => v.toFixed(3)).join(', ');
  drawPlan();
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
    state.points = d.points || []; state.lastScan = state.points.at(-1) || null;
    await save('points', state.points); drawAll();
  } catch (err) { setStatus('Arquivo inválido: ' + err.message, true); }
};
$('btnClear').onclick = async () => {
  if (state.points.length && !confirm('Começar uma nova sessão? Exporte antes: os pontos atuais serão apagados do aparelho.')) return;
  state.points = []; state.lastScan = null; state.pos = null; $('xy').value = '';
  await save('points', []); drawAll();
};

// ---------- Configurações ----------
function saveSettings() { save('settings', { ...params(), device: $('device').value, autoGps: $('autoGps').checked }); }

(async function init() {
  const s = await load('settings');
  if (s) {
    $('device').value = s.device ?? 0;
    $('fStart').value = s.startMHz; $('fStop').value = s.stopMHz; $('pts').value = s.points; $('avg').value = s.average;
    $('autoGps').checked = !!s.autoGps;
  }
  selectDevice();
  state.points = (await load('points')) || []; state.lastScan = state.points.at(-1) || null;
  await setPlan(await load('plan'));
  drawAll();
  if (state.points.length) log(`sessão restaurada: ${state.points.length} pontos`);
  if (!('serial' in navigator)) log(('usb' in navigator) ? 'Web Serial indisponível; será usado WebUSB.' : 'Navegador sem Web Serial e sem WebUSB.');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(e => log('service worker: ' + e.message));
})();
