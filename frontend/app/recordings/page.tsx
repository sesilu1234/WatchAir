"use client";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ACCENT, INK, MONO, PAPER } from "../theme";
import {
  isDeviceOnline,
  isDeviceStatus,
  isRecordingFinished,
  isRecordingStarted,
  isRecordingStopping,
  listDevices,
  listRecordings,
  startRecording,
  stopRecording,
  type Device,
  type Recording,
} from "../lib/api";
import { useCompact } from "../lib/useCompact";
import { useFrontendSocket, type WsStatus } from "../lib/useFrontendSocket";
import {
  durationSeconds,
  formatClock,
  formatNumber,
  formatRelativeDate,
  formatTime,
  recordingName,
} from "../lib/format";

export default function RecordingsPage() {
  const compact = useCompact();
  const { data: session } = useSession();
  const myDeviceUuid = session?.user?.deviceUuid ?? null;

  const [deviceOnline, setDeviceOnline] = useState<boolean | null>(null);
  const [uploading, setUploading] = useState(false);
  // Subida en curso ahora mismo, frente a "parada pero todavía sin subir"
  // (sin red, o esperando el reintento). Ambas se ven como "Subiendo".
  const [transferring, setTransferring] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [filterDeviceUuid, setFilterDeviceUuid] = useState("");
  const [filterDate, setFilterDate] = useState("");

  // Añade/actualiza una grabación en el estado local sin esperar a Supabase:
  // al arrancar, server2 confirma "grabando" antes de que la fila termine de
  // persistirse (ver notify_recording_started, fire-and-forget con reintentos),
  // así que si esperásemos solo al refetch la UI se quedaría pegada en "idle".
  const mergeRecording = useCallback((rec: Recording) => {
    setRecordings((prev) =>
      prev.some((r) => r.uuid === rec.uuid) ? prev : [rec, ...prev],
    );
  }, []);

  const refresh = useCallback(() => {
    listRecordings()
      .then((fetched) => {
        setRecordings((prev) => {
          // Conserva la grabación activa que ya conocemos (por la respuesta
          // del start o por el WS) si Supabase todavía no la refleja.
          const stillMissing = prev.filter(
            (r) =>
              r.device_uuid === myDeviceUuid &&
              r.ended_at === null &&
              !fetched.some((f) => f.uuid === r.uuid),
          );
          return [...stillMissing, ...fetched];
        });
      })
      .catch((err) => console.error(err));
    listDevices()
      .then(setDevices)
      .catch((err) => console.error(err));
  }, [myDeviceUuid]);

  useEffect(refresh, [refresh]);

  // La grabación activa de ESTA cuenta (grabando o subiendo): el WS solo
  // suscribe al propio device, así que solo se puede arrancar/parar el tuyo.
  const active = useMemo(
    () => recordings.find((r) => r.device_uuid === myDeviceUuid && r.ended_at === null) ?? null,
    [recordings, myDeviceUuid],
  );

  const handleMessage = useCallback(
    (data: unknown) => {
      if (isDeviceOnline(data)) {
        setDeviceOnline(data.type === "device_online");
        return;
      }
      if (isDeviceStatus(data)) {
        // Si hay una grabación viva y el aparato dice que ya no graba, lo que
        // queda es la subida — aunque nos hayamos perdido el recording_stopping
        // (server2 reiniciado, o esta pestaña abierta a mitad de la subida).
        setUploading(!data.recording);
        setTransferring(data.uploading);
        return;
      }
      if (isRecordingStarted(data)) {
        mergeRecording(data.recording);
        return;
      }
      if (isRecordingFinished(data)) {
        refresh();
        return;
      }
      if (isRecordingStopping(data)) {
        setUploading(true);
      }
    },
    [refresh, mergeRecording],
  );

  const wsStatus = useFrontendSocket({ onMessage: handleMessage, onOpen: refresh });

  // Cronómetro de la grabación en curso. 250 ms para que al entrar el valor
  // real aparezca sin salto visible (React descarta el render si no cambia).
  useEffect(() => {
    if (active == null) {
      setUploading(false);
      setTransferring(false);
      return;
    }
    const startedAt = Date.parse(active.started_at);
    const id = setInterval(
      () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))),
      250,
    );
    return () => clearInterval(id);
  }, [active]);

  const run = async (action: () => Promise<unknown>, afterUpload = false) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
      if (afterUpload) setUploading(true);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Un fallo de start/stop suele significar que el frontend iba con estado
      // atrasado respecto a server2 (p.ej. 409 "ya hay una grabación en
      // curso"); re-sincroniza para que el panel salte al que corresponde en
      // vez de dejar visible el botón equivocado.
      refresh();
    } finally {
      setPending(false);
    }
  };

  const history = useMemo(
    () =>
      recordings
        .filter((r) => r.uuid !== active?.uuid)
        .filter((r) => !filterDeviceUuid || r.device_uuid === filterDeviceUuid)
        .filter((r) => !filterDate || r.started_at.slice(0, 10) === filterDate),
    [recordings, active, filterDeviceUuid, filterDate],
  );

  return (
    <main style={{ ...styles.main, ...(compact ? mobile.main : null) }}>
      <header style={styles.header}>
        <h1 style={{ ...styles.title, ...(compact ? mobile.title : null) }}>Grabaciones</h1>
        <p style={styles.subtitle}>Historial de sesiones respiratorias · todas las cuentas</p>
      </header>

      <div style={{ ...styles.split, ...(compact ? mobile.split : null) }}>
        <div style={{ ...styles.topPane, ...(compact ? mobile.topPane : null) }}>
          {active != null ? (
            <RecordingNowPanel
              active={active}
              elapsedSeconds={elapsedSeconds}
              uploading={uploading}
              transferring={transferring}
              deviceOnline={deviceOnline}
              wsStatus={wsStatus}
              pending={pending}
              error={error}
              onStop={() => run(stopRecording, true)}
            />
          ) : (
            <NewRecordingPanel
              deviceOnline={deviceOnline}
              wsStatus={wsStatus}
              pending={pending}
              error={error}
              onStart={() => run(async () => mergeRecording(await startRecording()))}
            />
          )}
        </div>

        <div style={{ ...styles.bottomPane, ...(compact ? mobile.bottomPane : null) }}>
          <div style={styles.listHeader}>
            <div style={styles.listTitleGroup}>
              <span style={styles.listTitleIcon}>
                <ArchiveIcon />
              </span>
              <span style={styles.listTitle}>Historial</span>
            </div>
            <span style={styles.listCountPill}>{history.length} grabaciones</span>
          </div>

          <FilterBar
            devices={devices}
            deviceUuid={filterDeviceUuid}
            date={filterDate}
            onDeviceChange={setFilterDeviceUuid}
            onDateChange={setFilterDate}
          />

          <div style={styles.tableHead}>
            <span style={styles.tableHeadIconCol} />
            <span style={styles.tableHeadCell}>Grabación</span>
            <span style={styles.tableHeadCellRight}>Duración</span>
          </div>
          <div style={{ ...styles.rows, ...(compact ? mobile.rows : null) }}>
            {history.length === 0 ? (
              <div style={styles.empty}>
                <span style={styles.emptyIcon}>
                  <WaveIcon />
                </span>
                {recordings.length === 0 ? "Todavía no hay grabaciones." : "Nada con estos filtros."}
              </div>
            ) : (
              history.map((r) => <RecordingRow key={r.uuid} recording={r} />)
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

// --- Filtro por usuario y fecha ---

function FilterBar({
  devices,
  deviceUuid,
  date,
  onDeviceChange,
  onDateChange,
}: {
  devices: Device[];
  deviceUuid: string;
  date: string;
  onDeviceChange: (v: string) => void;
  onDateChange: (v: string) => void;
}) {
  return (
    <div style={styles.filterBar}>
      <select
        value={deviceUuid}
        onChange={(e) => onDeviceChange(e.target.value)}
        style={styles.filterSelect}
      >
        <option value="">Todos los usuarios</option>
        {devices.map((d) => (
          <option key={d.uuid} value={d.uuid}>
            {d.username}
          </option>
        ))}
      </select>
      <input
        type="date"
        value={date}
        onChange={(e) => onDateChange(e.target.value)}
        style={styles.filterSelect}
      />
      {(deviceUuid || date) && (
        <button
          type="button"
          onClick={() => {
            onDeviceChange("");
            onDateChange("");
          }}
          style={styles.filterClear}
        >
          Limpiar
        </button>
      )}
    </div>
  );
}

// --- Panel superior: idle ---

function NewRecordingPanel({
  deviceOnline,
  wsStatus,
  pending,
  error,
  onStart,
}: {
  deviceOnline: boolean | null;
  wsStatus: WsStatus;
  pending: boolean;
  error: string | null;
  onStart: () => void;
}) {
  const compact = useCompact();
  const [hovered, setHovered] = useState(false);
  const disabled = wsStatus !== "connected" || deviceOnline !== true || pending;
  const hover = hovered && !disabled;

  return (
    <div style={{ ...styles.idlePanel, ...(compact ? mobile.idlePanel : null) }}>
      <ConnectionBadge wsStatus={wsStatus} deviceOnline={deviceOnline} />
      <button
        onClick={onStart}
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...styles.newButton,
          ...(compact ? mobile.newButton : null),
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
      {error != null ? (
        <p style={styles.errorHint}>{error}</p>
      ) : (
        <p style={styles.idleHint}>
          {wsStatus !== "connected"
            ? "Esperando conexión con el servidor…"
            : deviceOnline !== true
              ? "Tu ESP32 no está conectada."
              : "Pulsa para empezar a registrar la señal respiratoria."}
        </p>
      )}
    </div>
  );
}

// --- Panel superior: grabando / subiendo ---

function RecordingNowPanel({
  active,
  elapsedSeconds,
  uploading,
  transferring,
  deviceOnline,
  wsStatus,
  pending,
  error,
  onStop,
}: {
  active: Recording;
  elapsedSeconds: number;
  uploading: boolean;
  transferring: boolean;
  deviceOnline: boolean | null;
  wsStatus: WsStatus;
  pending: boolean;
  error: string | null;
  onStop: () => void;
}) {
  const compact = useCompact();

  return (
    <div style={{ ...styles.livePanel, ...(compact ? mobile.livePanel : null) }}>
      <div style={styles.liveHeaderRow}>
        <div style={styles.liveTitleGroup}>
          <span style={styles.recDot} />
          <span style={styles.liveTitle}>{uploading ? "Subiendo" : "Recording Now"}</span>
        </div>
        <span style={styles.liveConnText}>
          {wsStatus !== "connected"
            ? "Reconectando…"
            : deviceOnline !== true
              ? "ESP32 desconectada"
              : uploading
                ? transferring
                  ? "Subiendo el fichero…"
                  : "Parada · pendiente de subir…"
                : "ESP32 Conectada · Grabando…"}
        </span>
      </div>

      <div style={styles.liveMetrics}>
        <div style={{ ...styles.liveMetric, ...(compact ? mobile.liveMetric : null) }}>
          <div style={styles.metricLabel}>Started</div>
          <div style={{ ...styles.metricValueLg, ...(compact ? mobile.metricValueLg : null) }}>
            {formatTime(new Date(active.started_at))}
          </div>
        </div>
        <div style={{ ...styles.liveMetric, ...(compact ? mobile.liveMetric : null) }}>
          <div style={styles.metricLabel}>Duration</div>
          <div style={{ ...styles.metricValueLg, ...(compact ? mobile.metricValueLg : null) }}>
            {formatClock(elapsedSeconds)}
          </div>
        </div>
        <div style={{ ...styles.liveMetric, ...(compact ? mobile.liveMetric : null) }}>
          <div style={styles.metricLabel}>Nombre</div>
          <div style={{ ...styles.metricValueSm, ...(compact ? mobile.metricValueSm : null) }}>
            {recordingName(active.started_at)}
          </div>
        </div>
      </div>

      <div style={styles.liveActions}>
        <Link
          href={`/recordings/${active.uuid}`}
          style={{
            ...styles.actionBtn,
            ...styles.actionBtnGhost,
            ...(compact ? mobile.actionBtn : null),
          }}
        >
          Live View
        </Link>
        <button
          onClick={onStop}
          disabled={pending || uploading}
          style={{
            ...styles.actionBtn,
            ...styles.actionBtnStop,
            ...(compact ? mobile.actionBtn : null),
            opacity: pending || uploading ? 0.6 : 1,
          }}
        >
          {uploading ? "Subiendo…" : "Stop"}
        </button>
        {error != null && <span style={styles.errorInline}>{error}</span>}
      </div>
    </div>
  );
}

// --- Fila de grabación ---

function RecordingRow({ recording }: { recording: Recording }) {
  const compact = useCompact();
  const [hover, setHover] = useState(false);
  const date = new Date(recording.started_at);
  const seconds = durationSeconds(recording.started_at, recording.ended_at);

  return (
    <Link
      href={`/recordings/${recording.uuid}`}
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
      <div style={{ ...styles.rowMain, ...(compact ? mobile.rowMain : null) }}>
        <span style={styles.rowName}>{recordingName(recording.started_at)}</span>
        <span style={{ ...styles.rowMeta, ...(compact ? mobile.rowMeta : null) }}>
          {recording.username} · {formatRelativeDate(date)} · {formatTime(date)}
        </span>
      </div>
      <span style={styles.rowDuration}>{seconds == null ? "Subiendo" : formatClock(seconds)}</span>
      <ChevronIcon />
    </Link>
  );
}

function ConnectionBadge({ wsStatus, deviceOnline }: { wsStatus: WsStatus; deviceOnline: boolean | null }) {
  const config = (() => {
    if (wsStatus !== "connected") {
      return {
        connecting: { color: "#ca8a04", text: "Conectando" },
        disconnected: { color: "#dc2626", text: "Desconectado" },
        error: { color: "#dc2626", text: "Error de red" },
      }[wsStatus as "connecting" | "disconnected" | "error"];
    }
    return deviceOnline ? { color: "#00e0a8", text: "ESP32 Conectada" } : { color: "#dc2626", text: "ESP32 Desconectada" };
  })();

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
    height: 300,
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
  errorHint: {
    fontFamily: MONO,
    fontSize: 11,
    color: "#dc2626",
    fontWeight: 700,
    margin: 0,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    textAlign: "center",
    maxWidth: 420,
  },
  errorInline: {
    alignSelf: "center",
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    color: "#dc2626",
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
  liveMetrics: { display: "flex", gap: 14, flexWrap: "wrap" },
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
  metricValueSm: { fontSize: 15, fontWeight: 900, marginTop: 8, fontFamily: MONO },
  liveActions: { display: "flex", gap: 12, flexWrap: "wrap" },
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
  filterBar: {
    display: "flex",
    gap: 8,
    marginBottom: 10,
    flexShrink: 0,
    flexWrap: "wrap",
  },
  filterSelect: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    color: INK,
    background: PAPER,
    border: `1.5px solid ${INK}`,
    borderRadius: 10,
    padding: "6px 12px",
    textTransform: "uppercase",
    cursor: "pointer",
  },
  filterClear: {
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 700,
    color: "#888",
    background: "transparent",
    border: "1px solid rgba(17,17,17,0.2)",
    borderRadius: 10, // mismo radio que los selects: la fila se lee como una sola pieza
    padding: "6px 12px",
    textTransform: "uppercase",
    cursor: "pointer",
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
  rowDuration: {
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

// --- Móvil: nada de alturas fijas ni de dos paneles repartiéndose la pantalla;
// la página entera hace scroll y el historial crece hacia abajo. ---
const mobile: Record<string, CSSProperties> = {
  main: {
    height: "auto",
    minHeight: "100%",
    overflow: "visible",
    padding: "16px 14px 22px",
    gap: 14,
  },
  title: { fontSize: 20 },
  split: { flex: "none", gap: 14 },
  topPane: { flex: "none" },
  bottomPane: {
    height: "auto",
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "14px 14px 4px",
  },
  rows: { flex: "none", overflowY: "visible" },

  idlePanel: { padding: "26px 16px", gap: 14 },
  newButton: { padding: "14px 20px", fontSize: 13, textAlign: "center" },

  livePanel: { padding: "18px 16px", gap: 16, boxShadow: `5px 5px 0 ${INK}` },
  liveMetric: { flex: "1 1 130px", padding: "8px 12px" },
  metricValueLg: { fontSize: 19 },
  metricValueSm: { fontSize: 13, marginTop: 6 },
  actionBtn: { flex: "1 1 140px", padding: "13px 14px", textAlign: "center" },

  rowMain: { flexDirection: "column", alignItems: "flex-start", gap: 2 },
  rowMeta: { whiteSpace: "normal" },
};
