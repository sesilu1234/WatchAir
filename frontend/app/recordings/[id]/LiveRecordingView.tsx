"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import LiveWaveform from "../../components/LiveWaveform";
import { MONO } from "../../theme";
import { getStatus, isRecordingState, stopRecording, type Recording } from "../../lib/api";
import { useFrontendSocket } from "../../lib/useFrontendSocket";
import { formatClock, formatTime, recordingName } from "../../lib/format";
import { BackLink, styles } from "./ui";

// Vista de la grabación que está en curso ahora mismo (ended_at === null).
export default function LiveRecordingView({ recording }: { recording: Recording }) {
  const router = useRouter();
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // El desfase entre el reloj del navegador y el del server: sin esto la
  // duración que se muestra puede salir desplazada varios segundos.
  const syncClock = useCallback(() => {
    getStatus()
      .then((s) => setClockOffsetMs(s.clockOffsetMs))
      .catch((err) => console.error(err));
  }, []);

  // Cuando el server anuncia que esta grabación ha terminado (stop desde otra
  // pestaña, caída del ESP32…) se re-renderiza la ruta: el Server Component
  // volverá a leer la fila y pasará a la vista de reproducción.
  const handleMessage = useCallback(
    (data: unknown) => {
      if (isRecordingState(data) && !data.rec && data.recording.id === recording.id) {
        router.refresh();
      }
    },
    [recording.id, router],
  );

  const wsStatus = useFrontendSocket({ onMessage: handleMessage, onOpen: syncClock });

  // 250 ms para que al entrar la duración real aparezca sin salto visible
  // (React descarta el render cuando el número no cambia).
  useEffect(() => {
    const startedAt = Date.parse(recording.started_at);
    const timer = setInterval(
      () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - clockOffsetMs - startedAt) / 1000))),
      250,
    );
    return () => clearInterval(timer);
  }, [recording.started_at, clockOffsetMs]);

  const handleStop = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await stopRecording();
      router.refresh(); // ended_at ya está puesto: recarga y pinta la gráfica
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <main style={styles.main}>
      <BackLink />
      <header style={{ ...styles.header, paddingRight: 260 }}>
        <div style={liveStyles.badgeRow}>
          <span style={liveStyles.dotOuter}>
            <span style={liveStyles.dotInner} />
          </span>
          <span style={liveStyles.badgeText}>Recording</span>
        </div>
        <h1 style={styles.title}>{recordingName(recording.started_at)}</h1>
        <p style={styles.subtitle}>Señal en tiempo real de la grabación en curso</p>
      </header>

      <div style={styles.bar}>
        <div style={styles.stat}>
          <div style={styles.statLabel}>Empezó a las</div>
          <div style={styles.statValue}>{formatTime(new Date(recording.started_at))}</div>
        </div>
        <div style={styles.stat}>
          <div style={styles.statLabel}>Duración</div>
          <div style={styles.statValue}>{formatClock(elapsedSeconds)}</div>
        </div>
        {error != null && <span style={liveStyles.error}>{error}</span>}
        <button
          onClick={handleStop}
          disabled={wsStatus !== "connected" || pending}
          style={{
            ...styles.button,
            ...styles.buttonStop,
            opacity: wsStatus !== "connected" || pending ? 0.5 : 1,
          }}
        >
          <StopIcon />
          {pending ? "Parando…" : "Stop Recording"}
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

const liveStyles = {
  badgeRow: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  dotOuter: {
    width: 14,
    height: 14,
    borderRadius: "50%",
    background: "rgba(220,38,38,0.18)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  dotInner: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#dc2626",
    animation: "recBlink 1.1s ease-in-out infinite",
  },
  badgeText: {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 900,
    color: "#dc2626",
    textTransform: "uppercase",
    letterSpacing: "0.08em",
  },
  error: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    color: "#dc2626",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    maxWidth: 260,
  },
} satisfies Record<string, React.CSSProperties>;
