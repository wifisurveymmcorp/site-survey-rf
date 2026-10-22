// Registro de dispositivos. Para incluir um novo (ex.: rádio Hytera via PEI), crie um módulo com
// { id, name, kind, connect(ctx), disconnect(), check(params), sweep(params, ctx) } e acrescente aqui.
// kind 'spectrum' devolve { freqs[], dbm[] }; um rádio poderia devolver kind 'rssi' com { rssi_dbm, ... }.
import { tinysa, tinysaSim } from './tinysa.js';

export const DEVICES = [tinysa, tinysaSim];
