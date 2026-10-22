// Transportes USB: Web Serial (preferido) e WebUSB CDC-ACM (reserva, útil em Android sem Web Serial).
// Os dois expõem a mesma interface: open(), write(Uint8Array), read() -> Uint8Array, close().

export class WebSerialTransport {
  static available() { return 'serial' in navigator; }
  constructor(baudRate = 115200, filters = []) { this.baudRate = baudRate; this.filters = filters; }
  // Reusa uma porta já autorizada antes; só abre a janela de escolha se não houver
  // noPrompt: só reabre uma porta já autorizada (usado ao reconectar depois de reiniciar o aparelho)
  async open({ noPrompt = false } = {}) {
    const known = (await navigator.serial.getPorts()).filter(p => this.matches(p.getInfo()));
    if (noPrompt && known.length !== 1) throw new Error('aparelho ainda não apareceu');
    this.port = known.length === 1 ? known[0] : await navigator.serial.requestPort({ filters: this.filters });
    await this.port.open({ baudRate: this.baudRate });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
  }
  matches(info) { return !this.filters.length || this.filters.some(f => f.usbVendorId === info.usbVendorId); }
  async write(bytes) { await this.writer.write(bytes); }
  async read() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error('porta fechada');
    return value;
  }
  async close() {
    try { this.reader?.releaseLock(); this.writer?.releaseLock(); await this.port?.close(); } catch (_) {}
  }
}

export class WebUsbCdcTransport {
  static available() { return 'usb' in navigator; }
  constructor(baudRate = 115200, filters = []) { this.baudRate = baudRate; this.filters = filters; }
  // Reusa o aparelho já autorizado (sem janela de escolha) quando há exatamente um compatível
  async open({ noPrompt = false } = {}) {
    const known = (await navigator.usb.getDevices()).filter(d => this.matches(d));
    if (noPrompt && known.length !== 1) throw new Error('aparelho ainda não apareceu');
    const d = this.dev = known.length === 1 ? known[0] : await navigator.usb.requestDevice({ filters: this.filters });
    await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    const ifaces = d.configuration.interfaces;
    const alt = i => i.alternates[0];
    const ctrl = ifaces.find(i => alt(i).interfaceClass === 0x02);
    const data = ifaces.find(i => alt(i).interfaceClass === 0x0a);
    if (!data) throw new Error('interface CDC de dados não encontrada');
    if (ctrl) { try { await d.claimInterface(ctrl.interfaceNumber); } catch (_) {} }
    await d.claimInterface(data.interfaceNumber);
    this.epIn = alt(data).endpoints.find(e => e.direction === 'in' && e.type === 'bulk').endpointNumber;
    this.epOut = alt(data).endpoints.find(e => e.direction === 'out' && e.type === 'bulk').endpointNumber;
    if (ctrl) {
      const index = ctrl.interfaceNumber;
      const lc = new DataView(new ArrayBuffer(7));
      lc.setUint32(0, this.baudRate, true); lc.setUint8(4, 0); lc.setUint8(5, 0); lc.setUint8(6, 8);
      const setup = request => ({ requestType: 'class', recipient: 'interface', request, value: 0, index });
      try { await d.controlTransferOut(setup(0x20), lc.buffer); } catch (_) {}            // SET_LINE_CODING
      try { await d.controlTransferOut({ ...setup(0x22), value: 0x03 }); } catch (_) {}    // DTR + RTS
    }
  }
  matches(d) {
    if (this.filters.length) return this.filters.some(f => f.vendorId === d.vendorId && (!f.productId || f.productId === d.productId));
    return d.vendorId === 0x0483 || /tinysa/i.test(d.productName || '');
  }
  async write(bytes) { await this.dev.transferOut(this.epOut, bytes); }
  async read() {
    const r = await this.dev.transferIn(this.epIn, 512);
    if (r.status !== 'ok') throw new Error('falha USB: ' + r.status);
    return new Uint8Array(r.data.buffer);
  }
  async close() { try { await this.dev?.close(); } catch (_) {} }
}

// Escolhe o transporte: Web Serial no computador, WebUSB no Android ou como reserva.
// No Android o Web Serial não lista o TinySA (testado no Chrome em 22/10/2026), então lá usamos WebUSB direto.
export function pickTransport(prefer, baudRate, usbFilters) {
  const android = /Android/i.test(navigator.userAgent);
  if (prefer !== 'webusb' && !(android && WebUsbCdcTransport.available()) && WebSerialTransport.available())
    return new WebSerialTransport(baudRate, usbFilters.map(f => ({ usbVendorId: f.vendorId, usbProductId: f.productId })));
  if (WebUsbCdcTransport.available()) return new WebUsbCdcTransport(baudRate, usbFilters);
  throw new Error('Este navegador não tem Web Serial nem WebUSB. Use o Chrome no Android ou no computador.');
}

// Canal de texto em cima do transporte: envia um comando e lê até o prompt.
export class LineChannel {
  constructor(transport, prompt, log = () => {}) {
    this.t = transport; this.prompt = prompt; this.log = log; this.buf = ''; this.dec = new TextDecoder();
    this.queue = Promise.resolve();
  }
  // Serializa os comandos para nunca misturar respostas
  cmd(line, timeoutMs = 20000) {
    const run = () => this._cmd(line, timeoutMs);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
  // Lê um pedaço do transporte com timeout, mantendo a leitura pendente para não perder bytes
  async _read(ms) {
    if (!this.pending) { this.pending = this.t.read(); this.pending.catch(() => {}); } // erro tratado no race abaixo
    let timer;
    const chunk = await Promise.race([this.pending, new Promise(res => { timer = setTimeout(() => res(null), ms); })])
      .finally(() => clearTimeout(timer));
    if (chunk) { this.pending = null; this.buf += this.dec.decode(chunk, { stream: true }); }
    return !!chunk;
  }
  // Descarta tudo que chegar até a linha ficar em silêncio (lixo de sessões anteriores, prompts extras)
  async drain(quietMs = 300) {
    await this.t.write(new TextEncoder().encode('\r'));
    while (await this._read(quietMs)) {}
    if (this.buf) this.log('descartado: ' + JSON.stringify(this.buf.slice(-200)));
    this.buf = '';
  }
  // Envia sem esperar resposta (ex.: "reset", que reinicia o aparelho e derruba o USB)
  async send(line) { await this.t.write(new TextEncoder().encode(line + '\r')); }
  async _cmd(line, timeoutMs) {
    this.buf = ''; // o comando anterior já terminou; o que sobrou é lixo
    await this.t.write(new TextEncoder().encode(line + '\r'));
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      // A resposta é o que vem depois do eco do comando e antes do próximo prompt;
      // isso ignora respostas atrasadas de comandos anteriores.
      const e = line ? this.buf.indexOf(line) : 0;
      const p = e >= 0 ? this.buf.indexOf(this.prompt, e + line.length) : -1;
      if (p >= 0) {
        const out = this.buf.slice(e + line.length, p).replace(/^\r?\n/, '');
        this.buf = this.buf.slice(p + this.prompt.length);
        this.log('> ' + line + '\n' + (out.length > 300 ? out.slice(0, 300) + '…' : out));
        return out;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('sem resposta para: ' + line);
      await this._read(left);
    }
  }
}
