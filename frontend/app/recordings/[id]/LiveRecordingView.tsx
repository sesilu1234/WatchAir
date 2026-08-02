"use client";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import LiveWaveform from "../../components/LiveWaveform";
import { MONO } from "../../theme";
import {
  isDeviceStatus,
  isRecordingFinished,
  isRecordingStopping,
  stopRecording,
  type Recording,
} from "../../lib/api";
import { useFrontendSocket } from "../../lib/useFrontendSocket";
import { formatClock, formatTime, recordingName } from "../../lib/format";
import { useCompact } from "../../lib/useCompact";
import { BackLink, mobile, styles } from "./ui";

// Vista de la grabación que está en curso ahora mismo (ended_at === null).
// Cubre dos fases sin que la BD lleve un `status`: grabando (se puede parar)
// y subiendo (tras el stop, hasta que llega recording_finished por WS).
export default function LiveRecordingView({ recording }: { recording: Recording }) {
  const router = useRouter();
  const compact = useCompact();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [pending, setPending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleMessage = useCallback(
    (data: unknown) => {
      if (isRecordingStopping(data) && data.uuid === recording.uuid) {
        setUploading(true);
        return;
      }
      if (isDeviceStatus(data) && data.uuid === recording.device_uuid) {
        // Esta vista solo se monta con ended_at === null, así que "el aparato
        // ya no graba" solo puede significar que queda la subida.
        setUploading(!data.recording);
        return;
      }
      if (isRecordingFinished(data) && data.uuid === recording.uuid) {
        router.refresh();
      }
    },
    [recording.uuid, router],
  );

  const wsStatus = useFrontendSocket({ onMessage: handleMessage });

  // 250 ms para que al entrar la duración real aparezca sin salto visible
  // (React descarta el render cuando el número no cambia).
  useEffect(() => {
    const startedAt = Date.parse(recording.started_at);
    const timer = setInterval(
      () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000))),
      250,
    );
    return () => clearInterval(timer);
  }, [recording.started_at]);

  const handleStop = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await stopRecording();
      setUploading(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending(false);
    }
  };

  return (
    <main style={{ ...styles.main, ...(compact ? mobile.main : null) }}>
      <BackLink />
      <header
        style={{ ...styles.header, paddingRight: 260, ...(compact ? mobile.header : null) }}
      >
        <div style={liveStyles.badgeRow}>
          <span style={liveStyles.dotOuter}>
            <span style={liveStyles.dotInner} />
          </span>
          <span style={liveStyles.badgeText}>{uploading ? "Subiendo" : "Recording"}</span>
        </div>
        <h1 style={{ ...styles.title, ...(compact ? mobile.title : null) }}>
          {recordingName(recording.started_at)}
        </h1>
        <p style={styles.subtitle}>
          {uploading
            ? "Grabación parada, subiendo el fichero desde la ESP32…"
            : "Señal en tiempo real de la grabación en curso"}
        </p>
      </header>

      <div style={{ ...styles.bar, ...(compact ? mobile.bar : null) }}>
        <div style={{ ...styles.stat, ...(compact ? mobile.stat : null) }}>
          <div style={styles.statLabel}>Empezó a las</div>
          <div style={{ ...styles.statValue, ...(compact ? mobile.statValue : null) }}>
            {formatTime(new Date(recording.started_at))}
          </div>
        </div>
        <div style={{ ...styles.stat, ...(compact ? mobile.stat : null) }}>
          <div style={styles.statLabel}>Duración</div>
          <div style={{ ...styles.statValue, ...(compact ? mobile.statValue : null) }}>
            {formatClock(elapsedSeconds)}
          </div>
        </div>
        {error != null && (
          <span style={{ ...liveStyles.error, ...(compact ? mobile.wide : null) }}>{error}</span>
        )}
        <button
          onClick={handleStop}
          disabled={wsStatus !== "connected" || pending || uploading}
          style={{
            ...styles.button,
            ...styles.buttonStop,
            ...(compact ? mobile.button : null),
            opacity: wsStatus !== "connected" || pending || uploading ? 0.5 : 1,
          }}
        >
          <StopIcon />
          {uploading ? "Subiendo…" : pending ? "Parando…" : "Stop Recording"}
        </button>
      </div>

      <LiveWaveform />

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
