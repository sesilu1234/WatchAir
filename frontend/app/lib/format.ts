// Formato de fechas, duraciones y tamaños. El backend nombra los ficheros
// como rec_YYYYMMDD_HHMMSS.csv, así que la fecha se extrae del nombre.
const FILENAME_RE = /rec_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/;

export function parseRecordingDate(file: string): Date | null {
  const m = FILENAME_RE.exec(file);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.slice(1).map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
export function formatRelativeDate(date: Date): string {
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);

  if (diffDays === 0) return "Hoy";
  if (diffDays === 1) return "Ayer";
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}
