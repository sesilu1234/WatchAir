// Datos de ejemplo para /recordings. El backend todavía no persiste grabaciones
// pasadas (solo retransmite la señal en vivo), así que por ahora la lista vive
// en localStorage en el navegador — se conectará a una API real más adelante.

export type Recording = {
  id: string;
  name: string;
  date: string; // ISO
  durationSeconds: number;
};

const STORAGE_KEY = "watchair:recordings";

const SEED: Recording[] = [
  {
    id: "seed-night-study",
    name: "Night Study",
    date: relativeIso(-1, 21, 15),
    durationSeconds: 7 * 3600 + 42 * 60,
  },
  {
    id: "seed-bedroom-test",
    name: "Bedroom Test",
    date: relativeIso(-2, 6, 30),
    durationSeconds: 8 * 3600 + 10 * 60,
  },
  {
    id: "seed-morning-baseline",
    name: "Morning Baseline",
    date: relativeIso(-7, 7, 5),
    durationSeconds: 6 * 3600 + 55 * 60,
  },
];

function relativeIso(daysOffset: number, hours: number, minutes: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysOffset);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
}

export function loadRecordings(): Recording[] {
  if (typeof window === "undefined") return SEED;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return SEED;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : SEED;
  } catch {
    return SEED;
  }
}

const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cachedList: Recording[] = SEED;

// Snapshot estable para useSyncExternalStore: solo re-parsea si el string
// crudo de localStorage cambió, para no romper la comparación por referencia.
export function getRecordingsSnapshot(): Recording[] {
  if (typeof window === "undefined") return SEED;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    try {
      const parsed = raw ? JSON.parse(raw) : SEED;
      cachedList = Array.isArray(parsed) ? parsed : SEED;
    } catch {
      cachedList = SEED;
    }
  }
  return cachedList;
}

export function getRecordingsServerSnapshot(): Recording[] {
  return SEED;
}

export function subscribeRecordings(callback: () => void): () => void {
  listeners.add(callback);
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

export function saveRecordings(list: Recording[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {}
  listeners.forEach((l) => l());
}

// --- Grabación activa: id + hora de inicio compartidos entre /recordings y ---
// --- /recordings/[id], para que el cronómetro y el enlace "Live View" sigan ---
// --- siendo correctos sin importar desde qué componente se detecte start/stop. ---

export type ActiveRecording = { id: string; startedAt: number };

const ACTIVE_KEY = "watchair:active-recording";

export function newRecordingId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function loadActiveRecording(): ActiveRecording | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    return raw ? (JSON.parse(raw) as ActiveRecording) : null;
  } catch {
    return null;
  }
}

const activeListeners = new Set<() => void>();
let cachedActiveRaw: string | null = null;
let cachedActive: ActiveRecording | null = null;

export function getActiveRecordingSnapshot(): ActiveRecording | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(ACTIVE_KEY);
  if (raw !== cachedActiveRaw) {
    cachedActiveRaw = raw;
    try {
      cachedActive = raw ? (JSON.parse(raw) as ActiveRecording) : null;
    } catch {
      cachedActive = null;
    }
  }
  return cachedActive;
}

export function getActiveRecordingServerSnapshot(): ActiveRecording | null {
  return null;
}

export function subscribeActiveRecording(callback: () => void): () => void {
  activeListeners.add(callback);
  const onStorage = (e: StorageEvent) => {
    if (e.key === ACTIVE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    activeListeners.delete(callback);
    window.removeEventListener("storage", onStorage);
  };
}

export function saveActiveRecording(active: ActiveRecording | null): void {
  try {
    if (active) localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
    else localStorage.removeItem(ACTIVE_KEY);
  } catch {}
  activeListeners.forEach((l) => l());
}

// Cierra una grabación activa: la vuelca al historial y limpia la marca "en curso".
export function finishActiveRecording(active: ActiveRecording): void {
  const duration = Math.max(1, Math.round((Date.now() - active.startedAt) / 1000));
  const prev = loadRecordings();
  const next: Recording[] = [
    {
      id: active.id,
      name: `Grabación ${prev.length + 1}`,
      date: new Date(active.startedAt).toISOString(),
      durationSeconds: duration,
    },
    ...prev,
  ];
  saveRecordings(next);
  saveActiveRecording(null);
}

// "7h 42m" — para grabaciones ya terminadas.
export function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// "00:03:27" — para el cronómetro de la grabación en curso.
export function formatClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

// "Hoy" / "Ayer" / "25 Jul"
export function formatRelativeDate(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);

  if (diffDays === 0) return "Hoy";
  if (diffDays === 1) return "Ayer";
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-ES", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
