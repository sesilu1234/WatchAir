// Cliente del frontend contra dos sitios distintos:
// - server2 (FastAPI/EC2): solo control de grabación/emisión y el WS en vivo,
//   siempre con el JWT corto que firma server1 (se pide y renueva aquí).
// - rutas propias del frontend (/api/recordings, /api/devices, .../data):
//   leen Supabase directo server-side, el navegador nunca toca Supabase.
//
// NEXT_PUBLIC_SERVER2_URL lleva el esquema incluido y sin barra final. El
// esquema importa: una página servida por https no puede abrir ws:// ni
// http:// (mixed content).
const SERVER2_URL = (process.env.NEXT_PUBLIC_SERVER2_URL ?? "").replace(/\/$/, "");
const WS_SERVER2_BASE = SERVER2_URL.replace(/^http/, "ws");

// Una grabación ya subida (o al menos con su fila creada). No existe fila para
// la que se está grabando ahora mismo: eso vive solo en el status del aparato.
export type Recording = {
  uuid: string;
  device_uuid: string;
  started_at: string;
  ended_at: string | null;
  file_path: string | null;
  duration_seconds: number | null;
  uploaded_at: string | null; // null = la fila existe pero el binario no llegó a Storage
  username: string;
};

export type Device = { uuid: string; username: string };

// Mensajes que llegan por el WS de server2.
export type DeviceOnlineMessage = { type: "device_online" | "device_offline"; uuid: string };
// Una grabación acaba de terminar de subirse: ya tiene fila, toca refrescar.
export type RecordingFinishedMessage = { type: "recording_finished"; uuid: string };

// Espejo del `status` de la ESP32 (cada 2 s y ante cualquier cambio). Es LO
// ÚNICO de lo que se pinta el estado del aparato: aquí no se deduce nada.
// Hay grabación en curso si y solo si `rec_uuid` no es null.
export type DeviceStatusMessage = {
  type: "device_status";
  uuid: string;
  rec_uuid: string | null;
  rec_started_epoch_ms: number | null; // t=0 de la grabación: es lo que le da nombre
  uploading: boolean; // subiendo un fichero ahora mismo
  pending: number; // ficheros en la SD esperando a subir
};
export type SampleMessage = { t: number; p: number; temp?: number };

export const isDeviceOnline = (d: unknown): d is DeviceOnlineMessage =>
  typeof d === "object" && d !== null && ((d as DeviceOnlineMessage).type === "device_online" || (d as DeviceOnlineMessage).type === "device_offline");

export const isRecordingFinished = (d: unknown): d is RecordingFinishedMessage =>
  typeof d === "object" && d !== null && (d as RecordingFinishedMessage).type === "recording_finished";

export const isDeviceStatus = (d: unknown): d is DeviceStatusMessage =>
  typeof d === "object" && d !== null && (d as DeviceStatusMessage).type === "device_status";

export const isSample = (d: unknown): d is SampleMessage =>
  typeof d === "object" && d !== null && typeof (d as SampleMessage).p === "number";

// --- Token corto contra server2: se pide a server1 y se cachea en memoria ---
// (nunca en localStorage: dura 15 min y no tiene sentido persistirlo).
let cachedToken: { token: string; expiresAt: number } | null = null;

export async function getServer2Token(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && cachedToken && cachedToken.expiresAt - now > 30_000) {
    return cachedToken.token;
  }
  const res = await fetch("/api/server2-token", { cache: "no-store" });
  if (!res.ok) throw new Error("No se pudo obtener el token de server2");
  const { token, expiresIn } = (await res.json()) as { token: string; expiresIn: number };
  cachedToken = { token, expiresAt: now + expiresIn * 1000 };
  return token;
}

// Se llama en cada (re)conexión: si el WS se cerró por token caducado, esto
// pide uno nuevo antes de reintentar.
export async function buildServer2WsUrl(): Promise<string> {
  const token = await getServer2Token();
  return `${WS_SERVER2_BASE}/ws?token=${encodeURIComponent(token)}`;
}

async function server2Request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getServer2Token();
  const res = await fetch(`${SERVER2_URL}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `${path} -> ${res.status}`);
  }
  return res.json();
}

// Las dos devuelven el estado del aparato ya confirmado por la ESP32 (server2
// espera a su status antes de contestar), en el mismo formato que llega por WS.
export const startRecording = () =>
  server2Request<DeviceStatusMessage>("/recordings/start", { method: "POST" });
export const stopRecording = () =>
  server2Request<DeviceStatusMessage>("/recordings/stop", { method: "POST" });

// --- Lecturas: rutas propias del frontend (Supabase por debajo, nunca desde el navegador) ---

export async function listRecordings(
  filters: { deviceUuid?: string; from?: string; to?: string } = {},
): Promise<Recording[]> {
  const qs = new URLSearchParams();
  if (filters.deviceUuid) qs.set("device_uuid", filters.deviceUuid);
  if (filters.from) qs.set("from", filters.from);
  if (filters.to) qs.set("to", filters.to);
  const suffix = qs.toString();
  const res = await fetch(`/api/recordings${suffix ? `?${suffix}` : ""}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/recordings -> ${res.status}`);
  return res.json();
}

export async function listDevices(): Promise<Device[]> {
  const res = await fetch("/api/devices", { cache: "no-store" });
  if (!res.ok) throw new Error(`/api/devices -> ${res.status}`);
  return res.json();
}

// Puntos [segundos, presión|null] ya con la regla de gaps aplicada (null =
// corte de línea). null en la presión, nunca en el tiempo.
export async function fetchRecordingSamples(uuid: string): Promise<[number, number | null][]> {
  const res = await fetch(`/api/recordings/${encodeURIComponent(uuid)}/data`, { cache: "no-store" });
  if (!res.ok) throw new Error(`No se pudieron descargar los datos (${res.status})`);
  return res.json();
}
