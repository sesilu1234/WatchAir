// Decodifica el formato binario que graba la ESP32 en su SD:
// cabecera (magic "WAIR" + versión + uuid + Hz + started_epoch) + registros
// fijos de 6 bytes (uint32 t_ms + int16 p_centiPa) a 25 Hz. Debe coincidir con
// esp32/include/recorder.h y con server/app/recordings.py (que solo recibe y
// reenvía los bytes tal cual).
export type Point = [number, number | null];

const MAGIC = "WAIR";
// v1: magic + version(1) + uuid(16) + hz(2)                  = 23 B
// v2: magic + version(1) + uuid(16) + hz(1) + started_epoch(4) = 26 B
const HEADER_SIZE_V1 = 4 + 1 + 16 + 2;
const HEADER_SIZE_V2 = 4 + 1 + 16 + 1 + 4;
const RECORD_SIZE = 6; // uint32 t_ms + int16 p_centiPa
export const LOOP_TIME_MS = 40; // 25 Hz — debe coincidir con el firmware y server2

// Regla de gaps: si el salto entre muestras consecutivas supera 2×LOOP_TIME,
// no se unen esos puntos — se inserta un punto y=null para cortar la línea.
export function decodeRecording(buffer: Buffer): Point[] {
  if (buffer.length < HEADER_SIZE_V1) return [];
  const magic = buffer.toString("ascii", 0, 4);
  if (magic !== MAGIC) throw new Error(`Cabecera de grabación inválida: "${magic}"`);

  // Se siguen leyendo las grabaciones v1 que ya estén en Storage.
  const version = buffer.readUInt8(4);
  const HEADER_SIZE = version >= 2 ? HEADER_SIZE_V2 : HEADER_SIZE_V1;
  if (buffer.length < HEADER_SIZE) return [];

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
