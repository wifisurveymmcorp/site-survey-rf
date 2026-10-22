// Transportes USB: Web Serial (preferido) e WebUSB CDC-ACM (reserva, útil em Android sem Web Serial).
// Os dois expõem a mesma interface: open(), write(Uint8Array), read() -> Uint8Array, close().

export class WebSerialTransport {
  static available() { return 'serial' in navigator; }
  constructor(baudRate = 115200, filters = []) { this.baudRate = baudRate; this.filters = filters; }
  async open() {
    this.port = await navigator.serial.requestPort({ filters: this.filters });
    await this.port.open({ baudRate: this.baudRate });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
  }
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
  async open() {
    const d = this.dev = await navigator.usb.requestDevice({ filters: this.filters });
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
  async write(bytes) { await this.dev.transferOut(this.epOut, bytes); }
  async read() {
    const r = await this.dev.transferIn(this.epIn, 512);
    if (r.status !== 'ok') throw new Error('falha USB: ' + r.status);
    return new Uint8Array(r.data.buffer);
  }
  async close() { try { await this.dev?.close(); } catch (_) {} }
}

// Escolhe o transporte disponível: Web Serial primeiro, WebUSB como reserva.
export function pickTransport(prefer, baudRate, usbFilters) {
  if (prefer !== 'webusb' && WebSerialTransport.available())
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
  async _cmd(line, timeoutMs) {
    await this.t.write(new TextEncoder().encode(line + '\r'));
    const deadline = Date.now() + timeoutMs;
    while (!this.buf.includes(this.prompt)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('sem resposta para: ' + line);
      // Mantém a leitura pendente entre timeouts para não perder bytes
      this.pending ??= this.t.read();
      let timer;
      const chunk = await Promise.race([this.pending, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('sem resposta para: ' + line)), left); })])
        .finally(() => clearTimeout(timer));
      this.pending = null;
      this.buf += this.dec.decode(chunk, { stream: true });
    }
    const i = this.buf.indexOf(this.prompt);
    let out = this.buf.slice(0, i); this.buf = this.buf.slice(i + this.prompt.length);
    const nl = out.indexOf('\n');
    if (line && nl >= 0 && out.slice(0, nl).includes(line.split(' ')[0])) out = out.slice(nl + 1); // remove eco
    this.log('> ' + line + '\n' + (out.length > 300 ? out.slice(0, 300) + '…' : out));
    return out;
  }
}
