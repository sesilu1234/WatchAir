"use client";
import Link from "next/link";
import { use, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import LiveWaveform from "../../components/LiveWaveform";
import { ACCENT, INK, MONO, PAPER } from "../../theme";
import {
  finishActiveRecording,
  formatClock,
  formatDuration,
  formatRelativeDate,
  formatTime,
  getActiveRecordingServerSnapshot,
  getActiveRecordingSnapshot,
  getRecordingsServerSnapshot,
  getRecordingsSnapshot,
  loadActiveRecording,
  loadRecordings,
  saveRecordings,
  subscribeActiveRecording,
  subscribeRecordings,
} from "../mockData";

const WEBSOCKET_URL = "ws://13.48.132.12:8000/frontend";

export default function RecordingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const active = useSyncExternalStore(
    subscribeActiveRecording,
    getActiveRecordingSnapshot,
    getActiveRecordingServerSnapshot,
  );

  if (active?.id === id) {
    return <LiveRecordingView id={id} startedAt={active.startedAt} />;
  }

  return <HistoricalRecordingView id={id} />;
}

// --- Vista en vivo: se llega aquí mientras esta grabación (su uuid) está en curso ---
function LiveRecordingView({ id, startedAt }: { id: string; startedAt: number }) {
  const wsRef = useRef<WebSocket | null>(null);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
  );

  // --- Conexión WebSocket: solo para detectar el fin de la grabación y enviar "stop" ---
  useEffect(() => {
    const ws = new WebSocket(WEBSOCKET_URL);
    wsRef.current = ws;
    ws.onopen = () => setWsStatus("connected");
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => setWsStatus("error");
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (typeof d.state !== "string") return;
        if (d.state !== "measuring") {
          const active = loadActiveRecording();
          if (active && active.id === id) finishActiveRecording(active);
        }
      } catch {}
    };
    return () => ws.close();
  }, [id]);

  // --- Cronómetro ---
  useEffect(() => {
    const tick = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  const handleStop = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ cmd: "stop" }));
  };

  return (
    <main style={styles.main}>
      <BackLink />
      <header style={{ ...styles.header, paddingRight: 140 }}>
        <div style={styles.recBadgeRow}>
          <span style={styles.recDotOuter}>
            <span style={styles.recDotInner} />
          </span>
          <span style={styles.recBadgeText}>Recording</span>
        </div>
        <h1 style={styles.title}>Live View</h1>
        <p style={styles.subtitle}>Señal en tiempo real de la grabación en curso</p>
      </header>

      <div style={styles.liveBar}>
        <div style={styles.liveBarStat}>
          <div style={styles.summaryLabel}>Empezó a las</div>
          <div style={styles.summaryValue}>{formatTime(new Date(startedAt).toISOString())}</div>
        </div>
        <div style={styles.liveBarStat}>
          <div style={styles.summaryLabel}>Duración</div>
          <div style={styles.summaryValue}>{formatClock(elapsedSeconds)}</div>
        </div>
        <button
          onClick={handleStop}
          disabled={wsStatus !== "connected"}
          style={{ ...styles.stopButton, opacity: wsStatus !== "connected" ? 0.5 : 1 }}
        >
          <StopIcon />
          Stop Recording
        </button>
      </div>

      <LiveWaveform hideMeasurementButton />

      <style>{`
        @keyframes recBlink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.15; }
        }
      `}</style>
    </main>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff">
      <rect x="5" y="5" width="14" height="14" />
    </svg>
  );
}

// --- Vista de una grabación ya terminada (datos de ejemplo) ---
function HistoricalRecordingView({ id }: { id: string }) {
  const recordings = useSyncExternalStore(
    subscribeRecordings,
    getRecordingsSnapshot,
    getRecordingsServerSnapshot,
  );
  const recording = recordings.find((r) => r.id === id);

  const handleDelete = () => {
    const next = loadRecordings().filter((r) => r.id !== id);
    saveRecordings(next);
  };

  if (!recording) {
    return (
      <main style={styles.main}>
        <BackLink />
        <div style={styles.notFound}>
          <p style={styles.notFoundText}>No se encontró esta grabación.</p>
          <Link href="/recordings" style={styles.backButton}>
            Volver a Grabaciones
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main style={styles.main}>
      <BackLink />
      <header style={styles.header}>
        <h1 style={styles.title}>{recording.name}</h1>
        <p style={styles.subtitle}>
          {formatRelativeDate(recording.date)} · {formatTime(recording.date)}
        </p>
      </header>

      <section style={styles.card}>
        <div style={styles.summaryRow}>
          <SummaryStat label="Fecha" value={new Date(recording.date).toLocaleDateString("es-ES")} />
          <SummaryStat label="Hora de inicio" value={formatTime(recording.date)} />
          <SummaryStat label="Duración" value={formatDuration(recording.durationSeconds)} />
        </div>

        <div style={styles.placeholder}>
          <p style={styles.placeholderText}>
            Los datos de la señal de esta sesión todavía no se guardan en el servidor.
            Esta vista mostrará la gráfica completa en cuanto el backend persista las
            grabaciones.
          </p>
        </div>

        <button onClick={handleDelete} style={styles.deleteButton}>
          Eliminar grabación
        </button>
      </section>
    </main>
  );
}

function BackLink() {
  return (
    <Link href="/recordings" style={styles.topBack}>
      <ChevronLeft />
      Grabaciones
    </Link>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.summaryStat}>
      <div style={styles.summaryLabel}>{label}</div>
      <div style={styles.summaryValue}>{value}</div>
    </div>
  );
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M15 5l-7 7 7 7" stroke={INK} strokeWidth="2.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

const styles: Record<string, CSSProperties> = {
  main: {
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    height: "100vh",
    width: "100%",
    boxSizing: "border-box",
    padding: "28px 48px 40px",
    background: PAPER,
    color: INK,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    overflow: "hidden",
    position: "relative",
  },
  recBadgeRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  recDotOuter: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: "rgba(220,38,38,0.18)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  recDotInner: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#dc2626",
    animation: "recBlink 1.1s ease-in-out infinite",
  },
  recBadgeText: {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 900,
    color: "#dc2626",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  liveBar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 14,
    background: "#ffffff",
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "14px 18px",
  },
  liveBarStat: {
    flex: "0 0 auto",
    paddingRight: 14,
    borderRight: "1px solid rgba(17,17,17,0.16)",
  },
  stopButton: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "#dc2626",
    color: "#fff",
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "12px 22px",
    fontFamily: MONO,
    fontSize: 13,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    cursor: "pointer",
  },
  topBack: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: INK,
    textDecoration: "none",
  },
  header: {
    borderBottom: `2px solid ${INK}`,
    paddingBottom: 14,
    flexShrink: 0,
  },
  title: {
    fontSize: 26,
    fontWeight: 900,
    letterSpacing: "-0.02em",
    textTransform: "uppercase",
    margin: 0,
  },
  subtitle: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#555",
    margin: "4px 0 0 0",
  },
  card: {
    flex: 1,
    minHeight: 0,
    background: "#ffffff",
    border: `3px solid ${INK}`,
    boxShadow: `8px 8px 0 ${INK}`,
    padding: 28,
    display: "flex",
    flexDirection: "column",
    gap: 20,
    overflowY: "auto",
  },
  summaryRow: { display: "flex", gap: 14, flexWrap: "wrap" },
  summaryStat: {
    flex: "0 0 auto",
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "10px 18px",
  },
  summaryLabel: {
    fontFamily: MONO,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontWeight: 700,
    color: "#555",
  },
  summaryValue: { fontSize: 20, fontWeight: 900, marginTop: 4, fontFamily: MONO },
  placeholder: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: `2px dashed rgba(17,17,17,0.35)`,
    padding: 24,
  },
  placeholderText: {
    fontFamily: MONO,
    fontSize: 12,
    color: "#666",
    textAlign: "center",
    maxWidth: 420,
    lineHeight: 1.6,
    margin: 0,
  },
  deleteButton: {
    alignSelf: "flex-start",
    background: PAPER,
    color: INK,
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "10px 18px",
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    cursor: "pointer",
  },
  notFound: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
  },
  notFoundText: {
    fontFamily: MONO,
    fontSize: 13,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  backButton: {
    background: ACCENT,
    color: INK,
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "10px 18px",
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    textDecoration: "none",
  },
};
