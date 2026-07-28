// Cliente del backend FastAPI: comandos por HTTP, datos en vivo por WebSocket.
// Una grabación se identifica por su UUID (el que devuelve /recording/start).
const API_HOST = process.env.NEXT_PUBLIC_API_HOST ?? "13.48.132.12:8000";

export const API_BASE = `http://${API_HOST}`;
export const WS_FRONTEND_URL = `ws://${API_HOST}/frontend`;

// Fila de la tabla `recordings`. ended_at === null <=> se está grabando ahora.
export type Recording = {
  id: string;
  client: string;
  started_at: string;
  ended_at: string | null;
  samples: number;
};

export type ServerStatus = {
  esp32_connected: boolean;
  frontends_connected: number;
  measuring: boolean;
  recording: Recording | null;
  server_time: string;
};

// El estado + cuánto adelanta el reloj del navegador respecto al del server.
// Restándoselo a Date.now() los cronómetros cuentan sobre started_at sin desfase.
export type StatusSnapshot = ServerStatus & { clockOffsetMs: number };

// Mensajes que llegan por el WS de frontends.
export type RecordingStateMessage = {
  rec: boolean;
  recording: Recording;
  reason?: string;
};
export type SensorStateMessage = { state: string };
export type SampleMessage = { t: number; p: number; temp?: number };

export const isRecordingState = (d: unknown): d is RecordingStateMessage =>
  typeof d === "object" && d !== null && typeof (d as RecordingStateMessage).rec === "boolean";

export const isSensorState = (d: unknown): d is SensorStateMessage =>
  typeof d === "object" && d !== null && typeof (d as SensorStateMessage).state === "string";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { cache: "no-store", ...init });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `${path} -> ${res.status}`);
  }
  return res.json();
}

export const startSensor = () => request<{ ok: boolean }>("/sensor/start", { method: "POST" });
export const stopSensor = () => request<{ ok: boolean }>("/sensor/stop", { method: "POST" });

export const startRecording = () => request<Recording>("/recording/start", { method: "POST" });
export const stopRecording = () => request<Recording>("/recording/stop", { method: "POST" });

export const listRecordings = () => request<Recording[]>("/recordings");

// Mide el desfase de reloj en el punto medio de la petición: así el error queda
// acotado por el RTT en vez de por la diferencia de hora entre las dos máquinas.
export async function getStatus(): Promise<StatusSnapshot> {
  const sentAt = Date.now();
  const status = await request<ServerStatus>("/status");
  const midpoint = (sentAt + Date.now()) / 2;
  return { ...status, clockOffsetMs: midpoint - Date.parse(status.server_time) };
}

// null = no existe (404). Un fallo de red sí lanza: son casos distintos.
export async function getRecording(id: string): Promise<Recording | null> {
  const res = await fetch(`${API_BASE}/recordings/${encodeURIComponent(id)}`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`/recordings/${id} -> ${res.status}`);
  return res.json();
}

export const recordingDataUrl = (id: string) =>
  `${API_BASE}/recordings/${encodeURIComponent(id)}/data`;

// Muestras de una grabación terminada, listas para ECharts: [segundos, presión].
// El CSV guarda t_ms (millis del ESP32), así que se normaliza contra la primera.
export async function fetchRecordingSamples(id: string): Promise<[number, number][]> {
  const res = await fetch(recordingDataUrl(id), { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudo descargar el CSV (${res.status})`);
  const csv = await res.text();

  const points: [number, number][] = [];
  let t0: number | null = null;

  for (const line of csv.split("\n")) {
    const comma = line.indexOf(",");
    if (comma < 0) continue; // cabecera "t_ms,p" y líneas vacías
    const t = Number(line.slice(0, comma));
    const p = Number(line.slice(comma + 1));
    if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
    if (t0 === null) t0 = t;
    points.push([(t - t0) / 1000, p]);
  }
  return points;
}
