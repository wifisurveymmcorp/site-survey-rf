// Dispositivo: TinySA Basic (e simulador).
// Protocolo: CDC serial 115200, comandos de texto terminados em \r, prompt "ch> ".
// "scan <início_hz> <fim_hz> <pontos> 3" devolve uma linha "freq_hz dBm" por ponto.
// O Basic tem dois conectores: LOW (0,1–350 MHz) e HIGH (240–960 MHz), escolhidos com "mode low|high input".
import { pickTransport, LineChannel } from '../transport.js';

// Rejeita se a promessa não terminar no prazo
const within = (p, ms, what) => Promise.race([Promise.resolve(p), new Promise((_, rej) => setTimeout(() => rej(new Error(what + ': sem resposta em ' + ms / 1000 + ' s')), ms))]);

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

// Conector usado: escolhido pela faixa, ou forçado (na sobreposição 240–350 MHz os dois servem)
function inputFor(startMHz, stopMHz, forced = 'auto') {
  if (!(startMHz >= 0.1) || !(stopMHz <= 960) || stopMHz <= startMHz) return null;
  const low = stopMHz <= 350, high = startMHz >= 240;
  if (forced === 'low') return low ? 'low' : null;
  if (forced === 'high') return high ? 'high' : null;
  return low ? 'low' : high ? 'high' : null;
}

const base = {
  kind: 'spectrum',
  bands: BANDS,
  defaults: { startMHz: 88, stopMHz: 108, points: 290, average: 3 },
  // Devolve { ok, hint } para mostrar ao usuário antes da coleta
  check({ startMHz, stopMHz, input = 'auto' }) {
    const m = inputFor(startMHz, stopMHz, input);
    if (m === 'low') return { ok: true, input: m, hint: 'Entrada LOW: antena no conector LOW.' };
    if (m === 'high') return { ok: true, input: m, hint: 'Entrada HIGH: antena no conector HIGH.' };
    if (input !== 'auto' && inputFor(startMHz, stopMHz)) return { ok: false, hint: `O conector ${input.toUpperCase()} não cobre esta faixa (LOW: 0,1–350 MHz, HIGH: 240–960 MHz).` };
    return { ok: false, hint: 'Faixa inválida para o Basic: use 0,1–350 MHz (LOW) ou 240–960 MHz (HIGH).' };
  },
};

export const tinysa = {
  ...base,
  id: 'tinysa-basic',
  name: 'TinySA Basic (USB)',
  async connect({ log, prefer }) {
    this.log = log; this.prefer = prefer;
    this.t = pickTransport(prefer, 115200, USB_FILTERS);
    await this.t.open();
    return this._hello();
  },
  async _hello(timeoutMs = 20000) {
    this.ch = new LineChannel(this.t, 'ch> ', this.log);
    this.input = null; this.rbw = null; this.att = null; // reenvia modo, RBW e atenuação na próxima varredura
    await this.ch.drain(); // limpa o que estiver no buffer antes do primeiro comando
    return (await this.ch.cmd('version', timeoutMs)).trim().split(/\r?\n/)[0];
  },
  async disconnect() { await this.t?.close(); },
  // Reabre o USB sem pedir para escolher o aparelho, tentando até o prazo (o TinySA leva alguns segundos para voltar)
  // Cada passo tem prazo, porque com o USB preso as chamadas do navegador podem nunca voltar.
  async _reopen(totalMs, usbReset = false) {
    if (usbReset && this.t?.reset) { this.log('reset do USB'); await within(this.t.reset(), 3000, 'reset do USB').catch(e => this.log(e.message)); }
    await within(this.t?.close(), 2000, 'fechar USB').catch(e => this.log(e.message));
    const end = Date.now() + totalMs;
    for (let k = 1; ; k++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        this.t = pickTransport(this.prefer, 115200, USB_FILTERS);
        await within(this.t.open({ noPrompt: true }), 4000, 'abrir USB');
        const v = await within(this._hello(3000), 6000, 'versão');
        this.log(`reconectado na tentativa ${k}`);
        return v;
      } catch (e) {
        this.log(`tentativa ${k}: ${e.message}`);
        await within(this.t?.close(), 2000, 'fechar USB').catch(() => {});
        if (Date.now() > end) throw new Error('o TinySA não voltou: ' + e.message);
      }
    }
  },
  // Destrava sem reiniciar: limpa a linha e confere se responde; se não, fecha e reabre o USB
  async recover() {
    const limit = new Promise((_, rej) => setTimeout(() => rej(new Error('USB parado')), 5000));
    try { await Promise.race([(async () => { await this.ch.drain(); await this.ch.cmd('version', 3000); })(), limit]); this.input = this.rbw = this.att = null; this.log('recuperado sem reabrir o USB'); return; }
    catch (e) { this.log('sem resposta (' + e.message + '); reabrindo o USB'); }
    await this._reopen(10000, true);
  },
  // Reinicia o TinySA pelo comando "reset" e reconecta sozinho
  async reboot() {
    try { await this.ch.send('reset'); } catch (_) {}
    this.log('comando reset enviado; aguardando o TinySA voltar');
    await new Promise(r => setTimeout(r, 2500));
    return this._reopen(20000);
  },
  // rbw: 'auto' ou kHz; att: 'auto' ou dB (comandos "rbw" e "attenuate" do TinySA)
  async sweep({ startMHz, stopMHz, points, rbw = 'auto', att = 'auto', input = 'auto' }) {
    const mode = inputFor(startMHz, stopMHz, input);
    if (this.input !== mode) { await this.ch.cmd(`mode ${mode} input`); this.input = mode; this.rbw = this.att = null; }
    if (this.rbw !== String(rbw)) { await this.ch.cmd(`rbw ${rbw}`); this.rbw = String(rbw); }
    if (this.att !== String(att)) { await this.ch.cmd(`attenuate ${att}`); this.att = String(att); }
    // prazo proporcional ao número de pontos: se passar disso, consideramos que travou
    const out = await this.ch.cmd(`scan ${Math.round(startMHz * 1e6)} ${Math.round(stopMHz * 1e6)} ${points} 3`, 15000 + points * 50);
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
  async recover() {},
  async reboot() { await new Promise(r => setTimeout(r, 1500)); return 'tinySA simulado (reiniciado)'; },
  async sweep({ startMHz, stopMHz, points, input = 'auto' }, ctx = {}) {
    const [x, y] = ctx.pos || [0.5, 0.5];
    const a = startMHz * 1e6, b = stopMHz * 1e6, bw = (b - a) / 120;
    // para testar o alerta de conector: localStorage.simAntenna = 'low' ou 'high' deixa o outro conector sem sinal
    let ant = null; try { ant = localStorage.simAntenna; } catch (_) {}
    const carriers = ant && ant !== inputFor(startMHz, stopMHz, input) ? [] : [[a + (b - a) * 0.3, 0.2, 0.3], [a + (b - a) * 0.7, 0.8, 0.7]];
    const freqs = [], dbm = [];
    for (let i = 0; i < points; i++) {
      const f = a + (b - a) * i / (points - 1);
      let lin = Math.pow(10, (-95 + Math.random() * 4) / 10);
      for (const [cf, cx, cy] of carriers) lin += Math.pow(10, (-30 - 60 * Math.hypot(x - cx, y - cy)) / 10) * Math.exp(-(((f - cf) / bw) ** 2));
      freqs.push(f); dbm.push(10 * Math.log10(lin));
    }
    await new Promise(r => setTimeout(r, 300));
    return { freqs, dbm, input: inputFor(startMHz, stopMHz, input) };
  },
};
