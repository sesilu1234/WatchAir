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

export type Recording = {
  uuid: string;
  device_uuid: string;
  started_at: string;
  ended_at: string | null;
  file_path: string | null;
  duration_seconds: number | null;
  username: string;
};

export type Device = { uuid: string; username: string };

// Mensajes que llegan por el WS de server2.
export type DeviceOnlineMessage = { type: "device_online" | "device_offline"; uuid: string };
export type RecordingStartedMessage = { type: "recording_started"; recording: Recording };
export type RecordingStoppingMessage = { type: "recording_stopping"; uuid: string };
export type RecordingFinishedMessage = { type: "recording_finished"; uuid: string };
// Estado real del aparato, derivado de su heartbeat (cada 2 s). Es lo que
// distingue "grabando" de "subiendo" cuando no hemos visto el recording_stopping
// — p. ej. si server2 se reinició, o si el browser entra a mitad de una subida.
export type DeviceStatusMessage = {
  type: "device_status";
  uuid: string;
  recording: boolean;
  uploading: boolean;
};
export type SampleMessage = { t: number; p: number; temp?: number };

export const isDeviceOnline = (d: unknown): d is DeviceOnlineMessage =>
  typeof d === "object" && d !== null && ((d as DeviceOnlineMessage).type === "device_online" || (d as DeviceOnlineMessage).type === "device_offline");

export const isRecordingStarted = (d: unknown): d is RecordingStartedMessage =>
  typeof d === "object" && d !== null && (d as RecordingStartedMessage).type === "recording_started";

export const isRecordingStopping = (d: unknown): d is RecordingStoppingMessage =>
  typeof d === "object" && d !== null && (d as RecordingStoppingMessage).type === "recording_stopping";

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

export const startRecording = () => server2Request<Recording>("/recordings/start", { method: "POST" });
export const stopRecording = () =>
  server2Request<{ uuid: string; device_uuid: string; status: string }>("/recordings/stop", { method: "POST" });

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
