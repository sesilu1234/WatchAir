"use client";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { ACCENT, INK, MONO, PAPER } from "../theme";
import {
  finishActiveRecording,
  formatClock,
  formatDuration,
  formatRelativeDate,
  formatTime,
  getRecordingsServerSnapshot,
  getRecordingsSnapshot,
  loadActiveRecording,
  newRecordingId,
  saveActiveRecording,
  subscribeRecordings,
  type Recording,
} from "./mockData";

const WEBSOCKET_URL = "ws://13.48.132.12:8000/frontend";

export default function RecordingsPage() {
  const wsRef = useRef<WebSocket | null>(null);

  const [wsStatus, setWsStatus] = useState("connecting");
  const [measuring, setMeasuring] = useState(false);
  // Si ya hay una grabación en curso (p.ej. venimos de /recordings/<uuid>), recupera su id y hora de inicio.
  const [startedAt, setStartedAt] = useState<number | null>(() => loadActiveRecording()?.startedAt ?? null);
  const [activeId, setActiveId] = useState<string | null>(() => loadActiveRecording()?.id ?? null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recordings = useSyncExternalStore(
    subscribeRecordings,
    getRecordingsSnapshot,
    getRecordingsServerSnapshot,
  );

  // --- Conexión WebSocket: solo estado + comandos start/stop, sin dibujar la señal aquí ---
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
        const nowMeasuring = d.state === "measuring";

        setMeasuring((wasMeasuring) => {
          if (nowMeasuring && !wasMeasuring) {
            // Reusa el id/hora de una grabación ya activa (evita perder el cronómetro al navegar)
            const existing = loadActiveRecording();
            const id = existing?.id ?? newRecordingId();
            const start = existing?.startedAt ?? Date.now();
            if (!existing) saveActiveRecording({ id, startedAt: start });
            setActiveId(id);
            setStartedAt(start);
          } else if (!nowMeasuring && wasMeasuring) {
            const active = loadActiveRecording();
            if (active) finishActiveRecording(active);
            setActiveId(null);
            setStartedAt(null);
          }
          return nowMeasuring;
        });
      } catch {}
    };
    return () => ws.close();
  }, []);

  // --- Cronómetro de la grabación en curso ---
  useEffect(() => {
    if (!measuring || startedAt == null) return;
    const tick = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [measuring, startedAt]);

  const toggleMeasurement = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ cmd: measuring ? "stop" : "start" }));
  };

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.title}>Grabaciones</h1>
        <p style={styles.subtitle}>Historial de sesiones respiratorias</p>
      </header>

      <div style={styles.split}>
        <div style={styles.topPane}>
          {measuring ? (
            <RecordingNowPanel
              activeId={activeId}
              startedAt={startedAt}
              elapsedSeconds={elapsedSeconds}
              wsStatus={wsStatus}
              onStop={toggleMeasurement}
            />
          ) : (
            <NewRecordingPanel wsStatus={wsStatus} onStart={toggleMeasurement} />
          )}
        </div>

        <div style={styles.bottomPane}>
          <div style={styles.listHeader}>
            <span style={styles.listTitle}>Historial</span>
            <span style={styles.listCount}>{recordings.length} grabaciones</span>
          </div>
          <div style={styles.tableHead}>
            <span style={styles.tableHeadIconCol} />
            <span style={styles.tableHeadCell}>Grabación</span>
            <span style={styles.tableHeadCellRight}>Duración</span>
          </div>
          <div style={styles.rows}>
            {recordings.length === 0 ? (
              <div style={styles.empty}>Todavía no hay grabaciones.</div>
            ) : (
              recordings.map((r) => <RecordingRow key={r.id} recording={r} />)
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

// --- Panel superior: idle ---

function NewRecordingPanel({
  wsStatus,
  onStart,
}: {
  wsStatus: string;
  onStart: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const disabled = wsStatus !== "connected";
  const hover = hovered && !disabled;

  return (
    <div style={styles.idlePanel}>
      <ConnectionBadge status={wsStatus} />
      <button
        onClick={onStart}
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...styles.newButton,
          border: hover ? `3px solid ${ACCENT}` : `3px solid ${INK}`,
          boxShadow: hover ? `6px 6px 0 ${ACCENT}` : `6px 6px 0 ${INK}`,
          transform: hover ? "translate(-2px, -2px)" : "none",
          opacity: disabled ? 0.4 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        <PlusIcon />
        Nueva Grabación
      </button>
      <p style={styles.idleHint}>
        {disabled
          ? "Esperando conexión con el ESP32…"
          : "Pulsa para empezar a registrar la señal respiratoria."}
      </p>
    </div>
  );
}

// --- Panel superior: grabando ---

function RecordingNowPanel({
  activeId,
  startedAt,
  elapsedSeconds,
  wsStatus,
  onStop,
}: {
  activeId: string | null;
  startedAt: number | null;
  elapsedSeconds: number;
  wsStatus: string;
  onStop: () => void;
}) {
  return (
    <div style={styles.livePanel}>
      <div style={styles.liveHeaderRow}>
        <div style={styles.liveTitleGroup}>
          <span style={styles.recDot} />
          <span style={styles.liveTitle}>Recording Now</span>
        </div>
        <span style={styles.liveConnText}>
          {wsStatus === "connected" ? "ESP32 Conectado · Recibiendo datos…" : "Reconectando…"}
        </span>
      </div>

      <div style={styles.liveMetrics}>
        <div style={styles.liveMetric}>
          <div style={styles.metricLabel}>Started</div>
          <div style={styles.metricValueLg}>
            {startedAt != null ? formatTime(new Date(startedAt).toISOString()) : "--:--"}
          </div>
        </div>
        <div style={styles.liveMetric}>
          <div style={styles.metricLabel}>Duration</div>
          <div style={styles.metricValueLg}>{formatClock(elapsedSeconds)}</div>
        </div>
      </div>

      <div style={styles.liveActions}>
        <Link
          href={activeId ? `/recordings/${activeId}` : "/recordings"}
          style={{ ...styles.actionBtn, ...styles.actionBtnGhost }}
        >
          Live View
        </Link>
        <button onClick={onStop} style={{ ...styles.actionBtn, ...styles.actionBtnStop }}>
          Stop
        </button>
      </div>
    </div>
  );
}

// --- Fila de grabación ---

function RecordingRow({ recording }: { recording: Recording }) {
  const [hover, setHover] = useState(false);
  return (
    <Link
      href={`/recordings/${recording.id}`}
      style={{ ...styles.row, background: hover ? "rgba(17,17,17,0.04)" : "transparent" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={styles.rowIcon}>
        <WaveIcon />
      </div>
      <div style={styles.rowMain}>
        <span style={styles.rowName}>{recording.name}</span>
        <span style={styles.rowMeta}>
          {formatRelativeDate(recording.date)} · {formatTime(recording.date)}
        </span>
      </div>
      <span style={styles.rowDuration}>{formatDuration(recording.durationSeconds)}</span>
      <ChevronIcon />
    </Link>
  );
}

function ConnectionBadge({ status }: { status: string }) {
  const config =
    (
      {
        connected: { color: "#00e0a8", text: "ESP32 Conectado" },
        connecting: { color: "#ca8a04", text: "Conectando" },
        disconnected: { color: "#dc2626", text: "Desconectado" },
        error: { color: "#dc2626", text: "Error de red" },
      } as Record<string, { color: string; text: string }>
    )[status] || { color: "#9ca3af", text: status };

  return (
    <div style={{ ...styles.badge, background: config.color }}>
      <span style={styles.badgeDot} />
      {config.text}
    </div>
  );
}

// --- Iconos ---

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M12 4v16M4 12h16" stroke={INK} strokeWidth="3" strokeLinecap="square" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M2 12h3l2-6 4 12 3-9 2 5h6"
        stroke="#999"
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M9 5l7 7-7 7" stroke="#aaa" strokeWidth="2.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

// --- Estilos: brutalista — bordes gruesos, sombra dura, sin curvas ---
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
    gap: 18,
    overflow: "hidden",
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
  split: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  topPane: {
    flex: 1,
    minHeight: 0,
    display: "flex",
  },
  bottomPane: {
    flexShrink: 0,
    height: 236,
    display: "flex",
    flexDirection: "column",
    background: "#ffffff",
    border: `1px solid rgba(17,17,17,0.16)`,
    padding: "14px 20px 4px",
  },

  // idle panel
  idlePanel: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    background: "#ffffff",
    border: `3px dashed ${INK}`,
    padding: 28,
  },
  newButton: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: ACCENT,
    color: INK,
    padding: "16px 28px",
    fontFamily: MONO,
    fontSize: 14,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    transition: "box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease",
  },
  idleHint: {
    fontFamily: MONO,
    fontSize: 11,
    color: "#666",
    margin: 0,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  badge: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "8px 14px",
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: INK,
  },
  badgeDot: { width: 8, height: 8, background: INK, borderRadius: "50%" },

  // live panel
  livePanel: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 22,
    background: "#ffffff",
    border: `3px solid ${INK}`,
    boxShadow: `8px 8px 0 ${INK}`,
    padding: "28px 32px",
  },
  liveHeaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
  },
  liveTitleGroup: { display: "flex", alignItems: "center", gap: 10 },
  recDot: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: "#dc2626",
    boxShadow: "0 0 0 4px rgba(220,38,38,0.18)",
  },
  liveTitle: {
    fontFamily: MONO,
    fontSize: 16,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  liveConnText: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "#555",
  },
  liveMetrics: { display: "flex", gap: 14 },
  liveMetric: {
    flex: "0 0 auto",
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "10px 18px",
  },
  metricLabel: {
    fontFamily: MONO,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontWeight: 700,
    color: "#555",
  },
  metricValueLg: { fontSize: 24, fontWeight: 900, marginTop: 4, fontFamily: MONO },
  liveActions: { display: "flex", gap: 12 },
  actionBtn: {
    flex: "0 0 auto",
    padding: "12px 22px",
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    textDecoration: "none",
    color: INK,
    cursor: "pointer",
  },
  actionBtnGhost: { background: PAPER },
  actionBtnStop: { background: "#dc2626", color: "#fff" },

  // list — versión más fina, tirando a tabla, sin el sombreado brutalista pesado
  listHeader: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 8,
    flexShrink: 0,
  },
  listTitle: {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  listCount: {
    fontFamily: MONO,
    fontSize: 10,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  tableHead: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 4px 6px",
    borderBottom: `1px solid rgba(17,17,17,0.5)`,
    flexShrink: 0,
  },
  tableHeadIconCol: { flexShrink: 0, width: 22 },
  tableHeadCell: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: 800,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  tableHeadCellRight: {
    flexShrink: 0,
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: 800,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  rows: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 4px",
    borderBottom: "1px solid rgba(17,17,17,0.08)",
    textDecoration: "none",
    color: INK,
  },
  rowIcon: {
    flexShrink: 0,
    width: 22,
    height: 22,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#888",
  },
  rowMain: { display: "flex", flexDirection: "row", alignItems: "baseline", gap: 8, minWidth: 0, flex: 1 },
  rowName: { fontSize: 12.5, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  rowMeta: {
    fontFamily: MONO,
    fontSize: 10,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
  },
  rowDuration: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 800,
    color: "#555",
    flexShrink: 0,
  },
  empty: {
    fontFamily: MONO,
    fontSize: 11,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    padding: "16px 4px",
  },
};
