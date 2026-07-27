// Cliente del backend FastAPI: comandos por HTTP, datos en vivo por WebSocket.
const API_HOST = "13.48.132.12:8000";

export const API_BASE = `http://${API_HOST}`;
export const WS_FRONTEND_URL = `ws://${API_HOST}/frontend`;

export type HealthStatus = {
  status: string;
  esp32_connected: boolean;
  frontends_connected: number;
  recording: boolean;
  recording_file: string | null;
};

export type RecordingFile = {
  file: string;
  size_bytes: number;
};

async function apiPost(path: string): Promise<{ ok: boolean; file?: string }> {
  const res = await fetch(`${API_BASE}${path}`, { method: "POST" });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `${path} -> ${res.status}`);
  }
  return res.json();
}

export const getHealth = (): Promise<HealthStatus> =>
  fetch(API_BASE).then((r) => r.json());

export const startSensor = () => apiPost("/sensor/start");
export const stopSensor = () => apiPost("/sensor/stop");
export const startRecording = () => apiPost("/recording/start");
export const stopRecording = () => apiPost("/recording/stop");

export const listRecordings = (): Promise<RecordingFile[]> =>
  fetch(`${API_BASE}/recordings`).then((r) => r.json());
