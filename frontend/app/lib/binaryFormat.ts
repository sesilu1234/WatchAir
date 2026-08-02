// Decodifica el formato binario que graba la ESP32 en su SD:
// cabecera (magic "WAIR" + versión + uuid + Hz) + registros fijos de 6 bytes
// (uint32 t_ms + int16 p_centiPa) a 25 Hz. Debe coincidir con esp32/src/recorder.cpp
// y con server/app/upload.py (que sólo recibe y reenvía los bytes tal cual).
export type Point = [number, number | null];

const MAGIC = "WAIR";
const HEADER_SIZE = 4 + 1 + 16 + 2; // magic + version(1) + uuid(16) + hz(2)
const RECORD_SIZE = 6; // uint32 t_ms + int16 p_centiPa
export const LOOP_TIME_MS = 40; // 25 Hz — debe coincidir con el firmware y server2

// Regla de gaps: si el salto entre muestras consecutivas supera 2×LOOP_TIME,
// no se unen esos puntos — se inserta un punto y=null para cortar la línea.
export function decodeRecording(buffer: Buffer): Point[] {
  if (buffer.length < HEADER_SIZE) return [];
  const magic = buffer.toString("ascii", 0, 4);
  if (magic !== MAGIC) throw new Error(`Cabecera de grabación inválida: "${magic}"`);

  const points: Point[] = [];
  let prevT: number | null = null;
  let t0: number | null = null;

  for (let offset = HEADER_SIZE; offset + RECORD_SIZE <= buffer.length; offset += RECORD_SIZE) {
    const tMs = buffer.readUInt32LE(offset);
    const pCentiPa = buffer.readInt16LE(offset + 4);
    if (t0 === null) t0 = tMs;

    if (prevT !== null && tMs - prevT > 2 * LOOP_TIME_MS) {
      points.push([(prevT - t0) / 1000 + LOOP_TIME_MS / 2000, null]);
    }
    points.push([(tMs - t0) / 1000, pCentiPa / 100]);
    prevT = tMs;
  }
  return points;
}
