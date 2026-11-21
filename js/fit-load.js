// Membuka ZIP/FIT di browser lalu menganalisis. Dekode dilakukan di HP/laptop,
// bukan di Edge Function, supaya tidak kena batas CPU 2 detik Supabase.
import { Decoder, Stream } from 'https://cdn.jsdelivr.net/npm/@garmin/fitsdk@21.222.0/+esm';
import { unzipSync } from 'https://cdn.jsdelivr.net/npm/fflate@0.8.3/+esm';
import { analyzeFit } from './fit-analyze.js';

export function extractFit(bytes) {
  // ZIP diawali "PK"
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const files = unzipSync(bytes);
    const name = Object.keys(files).find((k) => k.toLowerCase().endsWith('.fit')) || Object.keys(files)[0];
    if (!name) throw new Error('ZIP kosong');
    return files[name];
  }
  return bytes;
}

export function decodeAndAnalyze(bytes) {
  const fit = extractFit(bytes);
  const stream = Stream.fromByteArray(fit);
  if (!Decoder.isFIT(stream)) throw new Error('Bukan file FIT yang valid');
  const { messages, errors } = new Decoder(stream).read({ mergeHeartRates: true });
  if (!messages.recordMesgs?.length && errors.length) throw new Error('Gagal membaca FIT: ' + errors[0]);
  return analyzeFit(messages);
}
