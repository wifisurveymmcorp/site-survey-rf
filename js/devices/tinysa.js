// Dispositivo: TinySA Basic (e simulador).
// Protocolo: CDC serial 115200, comandos de texto terminados em \r, prompt "ch> ".
// "scan <início_hz> <fim_hz> <pontos> 3" devolve uma linha "freq_hz dBm" por ponto.
// O Basic tem dois conectores: LOW (0,1–350 MHz) e HIGH (240–960 MHz), escolhidos com "mode low|high input".
import { pickTransport, LineChannel } from '../transport.js';

// Sem filtro: a janela do Chrome lista todos os dispositivos USB/seriais, o que ajuda a diagnosticar.
// O TinySA aparece como STM32 Virtual COM (VID 0x0483, PID 0x5740).
const USB_FILTERS = [];

const BANDS = [
  ['FM 88–108 MHz', 88, 108],
  ['Aeronáutico VHF 118–137 MHz', 118, 137],
  ['VHF 144–174 MHz', 144, 174],
  ['TV VHF 174–216 MHz', 174, 216],
  ['TETRA 380–430 MHz', 380, 430],
  ['UHF rádio 400–470 MHz', 400, 470],
  ['TV digital UHF 470–698 MHz', 470, 698],
  ['4G 700 MHz (B28) 703–803 MHz', 703, 803],
  ['Celular 850 MHz (B5) 824–894 MHz', 824, 894],
  ['GSM/LTE 900 MHz (B8) 880–960 MHz', 880, 960],
];

function inputFor(startMHz, stopMHz) {
  if (!(startMHz >= 0.1) || !(stopMHz <= 960) || stopMHz <= startMHz) return null;
  if (stopMHz <= 350) return 'low';
  if (startMHz >= 240) return 'high';
  return null;
}

const base = {
  kind: 'spectrum',
  bands: BANDS,
  defaults: { startMHz: 88, stopMHz: 108, points: 290, average: 3 },
  // Devolve { ok, hint } para mostrar ao usuário antes da coleta
  check({ startMHz, stopMHz }) {
    const m = inputFor(startMHz, stopMHz);
    if (m === 'low') return { ok: true, hint: 'Entrada LOW: antena no conector LOW.' };
    if (m === 'high') return { ok: true, hint: 'Entrada HIGH: antena no conector HIGH.' };
    return { ok: false, hint: 'Faixa inválida para o Basic: use 0,1–350 MHz (LOW) ou 240–960 MHz (HIGH).' };
  },
};

export const tinysa = {
  ...base,
  id: 'tinysa-basic',
  name: 'TinySA Basic (USB)',
  async connect({ log, prefer }) {
    this.t = pickTransport(prefer, 115200, USB_FILTERS);
    await this.t.open();
    this.ch = new LineChannel(this.t, 'ch> ', log);
    this.input = null;
    await this.ch.cmd('', 3000).catch(() => {}); // sincroniza no prompt
    return (await this.ch.cmd('version')).trim().split(/\r?\n/)[0];
  },
  async disconnect() { await this.t?.close(); },
  async sweep({ startMHz, stopMHz, points }) {
    const mode = inputFor(startMHz, stopMHz);
    if (this.input !== mode) { await this.ch.cmd(`mode ${mode} input`); this.input = mode; }
    const out = await this.ch.cmd(`scan ${Math.round(startMHz * 1e6)} ${Math.round(stopMHz * 1e6)} ${points} 3`, 60000);
    const freqs = [], dbm = [];
    for (const l of out.split(/\r?\n/)) {
      const m = l.trim().split(/\s+/);
      if (m.length >= 2 && isFinite(m[0]) && isFinite(m[1]) && m[0] !== '') { freqs.push(+m[0]); dbm.push(+m[1]); }
    }
    if (freqs.length < 2) throw new Error('resposta do scan vazia ou inválida');
    return { freqs, dbm, input: mode };
  },
};

// Simulador: ruído + duas portadoras cuja intensidade depende da posição marcada na planta
export const tinysaSim = {
  ...base,
  id: 'tinysa-sim',
  name: 'TinySA simulado (sem aparelho)',
  async connect() { return 'tinySA simulado'; },
  async disconnect() {},
  async sweep({ startMHz, stopMHz, points }, ctx = {}) {
    const [x, y] = ctx.pos || [0.5, 0.5];
    const a = startMHz * 1e6, b = stopMHz * 1e6, bw = (b - a) / 120;
    const carriers = [[a + (b - a) * 0.3, 0.2, 0.3], [a + (b - a) * 0.7, 0.8, 0.7]];
    const freqs = [], dbm = [];
    for (let i = 0; i < points; i++) {
      const f = a + (b - a) * i / (points - 1);
      let lin = Math.pow(10, (-95 + Math.random() * 4) / 10);
      for (const [cf, cx, cy] of carriers) lin += Math.pow(10, (-30 - 60 * Math.hypot(x - cx, y - cy)) / 10) * Math.exp(-(((f - cf) / bw) ** 2));
      freqs.push(f); dbm.push(10 * Math.log10(lin));
    }
    await new Promise(r => setTimeout(r, 300));
    return { freqs, dbm, input: inputFor(startMHz, stopMHz) };
  },
};
