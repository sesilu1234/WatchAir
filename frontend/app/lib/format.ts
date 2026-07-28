// Formato de fechas y duraciones. El backend identifica las grabaciones por UUID,
// así que el nombre visible se deriva de started_at.
const pad = (n: number) => String(n).padStart(2, "0");

// "REC_20260728_100200" — nombre legible y ordenable de una grabación.
export function recordingName(startedAt: string): string {
  const d = new Date(startedAt);
  if (Number.isNaN(d.getTime())) return "REC_—";
  return (
    `REC_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

// "00:03:27" — cronómetro de la grabación en curso y duración de las terminadas.
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// Duración de una grabación ya cerrada; null si sigue en curso.
export function durationSeconds(startedAt: string, endedAt: string | null): number | null {
  if (endedAt === null) return null;
  const ms = Date.parse(endedAt) - Date.parse(startedAt);
  return Number.isFinite(ms) ? Math.max(0, ms / 1000) : null;
}

// "Hoy" / "Ayer" / "25 jul"
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

export function formatDate(date: Date): string {
  return date.toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });
}

// Números con coma decimal y separador de miles, como el resto de la UI.
export function formatNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("es-ES", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
