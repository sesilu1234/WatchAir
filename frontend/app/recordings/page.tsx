"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ACCENT, INK, MONO, PAPER } from "../theme";
import {
  getHealth,
  listRecordings,
  startRecording,
  stopRecording,
  WS_FRONTEND_URL,
  type RecordingFile,
} from "../lib/api";
import { formatBytes, formatClock, formatRelativeDate, formatTime, parseRecordingDate } from "../lib/format";

export default function RecordingsPage() {
  const wsRef = useRef<WebSocket | null>(null);

  const [wsStatus, setWsStatus] = useState("connecting");
  const [measuring, setMeasuring] = useState(false);
  // activeId != null <=> hay una grabación (persistida en el server) en curso.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [pending, setPending] = useState(false);
  const [recordings, setRecordings] = useState<RecordingFile[]>([]);

  const refreshRecordings = useCallback(() => {
    listRecordings()
      .then(setRecordings)
      .catch((err) => console.error(err));
  }, []);

  // --- Estado inicial: por si ya hay una grabación en curso al cargar la página ---
  useEffect(() => {
    refreshRecordings();
    getHealth()
      .then((h) => {
        if (h.recording) {
          setActiveId(h.recording_file);
          setStartedAt(Date.now()); // el server no guarda la hora de inicio
        }
      })
      .catch((err) => console.error(err));
  }, [refreshRecordings]);

  // --- WebSocket: solo estado + datos, los comandos van por HTTP ---
  useEffect(() => {
    const ws = new WebSocket(WS_FRONTEND_URL);
    wsRef.current = ws;
    ws.onopen = () => setWsStatus("connected");
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => setWsStatus("error");
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (typeof d.state === "string") {
          setMeasuring(d.state === "measuring");
          return;
        }
        if (typeof d.rec === "boolean") {
          if (d.rec) {
            setActiveId(d.file ?? null);
            setStartedAt(Date.now());
          } else {
            setActiveId(null);
            setStartedAt(null);
            refreshRecordings();
          }
        }
      } catch {}
    };
    return () => ws.close();
  }, [refreshRecordings]);

  // --- Cronómetro de la grabación en curso ---
  useEffect(() => {
    if (activeId == null || startedAt == null) return;
    const tick = () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [activeId, startedAt]);

  const handleStart = async () => {
    if (pending) return;
    setPending(true);
    try {
      const res = await startRecording();
      if (res.file) {
        setActiveId(res.file);
        setStartedAt(Date.now());
      }
    } catch (err) {
      console.error(err);
    } finally {
      setPending(false);
    }
  };

  const handleStop = async () => {
    if (pending) return;
    setPending(true);
    try {
      await stopRecording();
      setActiveId(null);
      setStartedAt(null);
      refreshRecordings();
    } catch (err) {
      console.error(err);
    } finally {
      setPending(false);
    }
  };

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.title}>Grabaciones</h1>
        <p style={styles.subtitle}>Historial de sesiones respiratorias</p>
      </header>

      <div style={styles.split}>
        <div style={styles.topPane}>
          {activeId != null ? (
            <RecordingNowPanel
              activeId={activeId}
              startedAt={startedAt}
              elapsedSeconds={elapsedSeconds}
              measuring={measuring}
              wsStatus={wsStatus}
              pending={pending}
              onStop={handleStop}
            />
          ) : (
            <NewRecordingPanel wsStatus={wsStatus} pending={pending} onStart={handleStart} />
          )}
        </div>

        <div style={styles.bottomPane}>
          <div style={styles.listHeader}>
            <div style={styles.listTitleGroup}>
              <span style={styles.listTitleIcon}>
                <ArchiveIcon />
              </span>
              <span style={styles.listTitle}>Historial</span>
            </div>
            <span style={styles.listCountPill}>{recordings.length} grabaciones</span>
          </div>
          <div style={styles.tableHead}>
            <span style={styles.tableHeadIconCol} />
            <span style={styles.tableHeadCell}>Grabación</span>
            <span style={styles.tableHeadCellRight}>Tamaño</span>
          </div>
          <div style={styles.rows}>
            {recordings.length === 0 ? (
              <div style={styles.empty}>
                <span style={styles.emptyIcon}>
                  <WaveIcon />
                </span>
                Todavía no hay grabaciones.
              </div>
            ) : (
              recordings.map((r) => <RecordingRow key={r.file} recording={r} />)
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
  pending,
  onStart,
}: {
  wsStatus: string;
  pending: boolean;
  onStart: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const disabled = wsStatus !== "connected" || pending;
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
        {wsStatus !== "connected"
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
  measuring,
  wsStatus,
  pending,
  onStop,
}: {
  activeId: string;
  startedAt: number | null;
  elapsedSeconds: number;
  measuring: boolean;
  wsStatus: string;
  pending: boolean;
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
          {wsStatus !== "connected"
            ? "Reconectando…"
            : measuring
              ? "ESP32 Conectado · Recibiendo datos…"
              : "ESP32 Conectado · Esperando datos…"}
        </span>
      </div>

      <div style={styles.liveMetrics}>
        <div style={styles.liveMetric}>
          <div style={styles.metricLabel}>Started</div>
          <div style={styles.metricValueLg}>{startedAt != null ? formatTime(new Date(startedAt)) : "--:--"}</div>
        </div>
        <div style={styles.liveMetric}>
          <div style={styles.metricLabel}>Duration</div>
          <div style={styles.metricValueLg}>{formatClock(elapsedSeconds)}</div>
        </div>
      </div>

      <div style={styles.liveActions}>
        <Link
          href={`/recordings/${encodeURIComponent(activeId)}`}
          style={{ ...styles.actionBtn, ...styles.actionBtnGhost }}
        >
          Live View
        </Link>
        <button
          onClick={onStop}
          disabled={pending}
          style={{ ...styles.actionBtn, ...styles.actionBtnStop, opacity: pending ? 0.6 : 1 }}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

// --- Fila de grabación ---

function RecordingRow({ recording }: { recording: RecordingFile }) {
  const [hover, setHover] = useState(false);
  const date = parseRecordingDate(recording.file);
  return (
    <Link
      href={`/recordings/${encodeURIComponent(recording.file)}`}
      style={{
        ...styles.row,
        background: hover ? "rgba(0,224,168,0.08)" : "transparent",
        borderLeft: hover ? `2px solid ${ACCENT}` : "2px solid transparent",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={styles.rowIcon}>
        <WaveIcon />
      </div>
      <div style={styles.rowMain}>
        <span style={styles.rowName}>{recording.file}</span>
        <span style={styles.rowMeta}>
          {date ? `${formatRelativeDate(date)} · ${formatTime(date)}` : "Fecha desconocida"}
        </span>
      </div>
      <span style={styles.rowSize}>{formatBytes(recording.size_bytes)}</span>
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

function ArchiveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="13" height="14" stroke={INK} strokeWidth="2" />
      <path d="M16.5 10 21 7.5v9L16.5 14" stroke={INK} strokeWidth="2" strokeLinejoin="miter" />
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
    height: 252,
    display: "flex",
    flexDirection: "column",
    background: "#ffffff",
    border: `2px solid ${INK}`,
    boxShadow: `6px 6px 0 ${INK}`,
    padding: "16px 22px 6px",
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

  // list — cabecera con icono + pill de conteo, filas con acento en hover
  listHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
    flexShrink: 0,
  },
  listTitleGroup: { display: "flex", alignItems: "center", gap: 8 },
  listTitleIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: ACCENT,
    border: `1.5px solid ${INK}`,
  },
  listTitle: {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  listCountPill: {
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 700,
    color: INK,
    background: "rgba(17,17,17,0.06)",
    border: "1px solid rgba(17,17,17,0.16)",
    borderRadius: 999,
    padding: "3px 10px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  tableHead: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 4px 8px",
    borderBottom: `2px solid ${INK}`,
    flexShrink: 0,
  },
  tableHeadIconCol: { flexShrink: 0, width: 30 },
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
    padding: "9px 6px 9px 4px",
    borderBottom: "1px solid rgba(17,17,17,0.08)",
    textDecoration: "none",
    color: INK,
    transition: "background-color 0.12s ease, border-color 0.12s ease",
  },
  rowIcon: {
    flexShrink: 0,
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#888",
    background: PAPER,
    border: "1px solid rgba(17,17,17,0.16)",
  },
  rowMain: { display: "flex", flexDirection: "row", alignItems: "baseline", gap: 8, minWidth: 0, flex: 1 },
  rowName: {
    fontFamily: MONO,
    fontSize: 11.5,
    fontWeight: 700,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  rowMeta: {
    fontFamily: MONO,
    fontSize: 10,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
  },
  rowSize: {
    fontFamily: MONO,
    fontSize: 10.5,
    fontWeight: 800,
    color: INK,
    background: "rgba(17,17,17,0.05)",
    border: "1px solid rgba(17,17,17,0.14)",
    borderRadius: 999,
    padding: "3px 10px",
    flexShrink: 0,
  },
  empty: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    fontFamily: MONO,
    fontSize: 11,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    padding: "16px 4px",
  },
  emptyIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    border: "2px dashed rgba(17,17,17,0.3)",
  },
};
