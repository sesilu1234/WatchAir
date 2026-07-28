"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ECharts } from "echarts";
import { INK, MONO } from "../../theme";
import { fetchRecordingSamples, recordingDataUrl, type Recording } from "../../lib/api";
import {
  durationSeconds,
  formatDate,
  formatClock,
  formatNumber,
  formatTime,
  recordingName,
} from "../../lib/format";
import { chartOption, type Points } from "./chartOption";
import { BackLink, Stat, styles } from "./ui";

// Vista de una grabación ya terminada: no hay tiempo real, se pinta el CSV entero.
export default function RecordingPlayback({ recording }: { recording: Recording }) {
  const [points, setPoints] = useState<Points | null>(null);
  const [error, setError] = useState<string | null>(null);

  // page.tsx monta este componente con key={id}, así que al cambiar de grabación
  // se remonta y el estado arranca limpio: aquí sólo hace falta pedir el CSV.
  useEffect(() => {
    let cancelled = false;
    fetchRecordingSamples(recording.id)
      .then((p) => !cancelled && setPoints(p))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [recording.id]);

  const started = new Date(recording.started_at);
  const seconds = durationSeconds(recording.started_at, recording.ended_at);
  const summary = useMemo(() => describe(points), [points]);

  return (
    <main style={styles.main}>
      <BackLink />
      <header style={styles.header}>
        <h1 style={styles.title}>{recordingName(recording.started_at)}</h1>
        <p style={styles.subtitle}>
          {formatDate(started)} · {formatTime(started)} · {recording.client}
        </p>
      </header>

      <div style={styles.bar}>
        <Stat label="Duración" value={seconds == null ? "—" : formatClock(seconds)} />
        <Stat label="Muestras" value={formatNumber(recording.samples)} />
        <Stat
          label="Frecuencia"
          value={seconds ? `${formatNumber(recording.samples / seconds, 1)} Hz` : "—"}
        />
        <Stat label="Mín / Máx" value={summary ? `${summary.min} / ${summary.max} Pa` : "—"} />
        <Stat label="Media" value={summary ? `${summary.mean} Pa` : "—"} />
        <a
          href={recordingDataUrl(recording.id)}
          download={`${recordingName(recording.started_at)}.csv`}
          style={{ ...styles.button, ...styles.buttonAccent, marginLeft: "auto" }}
        >
          <DownloadIcon />
          Descargar CSV
        </a>
      </div>

      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <span style={styles.cardTitle}>Flujo de aire (Presión) · Pa</span>
          <span style={playbackStyles.hint}>Rueda o arrastra para hacer zoom</span>
        </div>
        <ChartArea points={points} error={error} />
      </section>
    </main>
  );
}

function ChartArea({ points, error }: { points: Points | null; error: string | null }) {
  if (error != null) return <Placeholder text={`No se pudieron cargar los datos: ${error}`} />;
  if (points == null) return <Placeholder text="Cargando muestras…" />;
  if (points.length === 0) return <Placeholder text="Esta grabación no tiene ninguna muestra." />;
  return <PressureChart points={points} />;
}

function Placeholder({ text }: { text: string }) {
  return (
    <div style={playbackStyles.placeholder}>
      <p style={playbackStyles.placeholderText}>{text}</p>
    </div>
  );
}

// --- Gráfica ECharts ---

function PressureChart({ points }: { points: Points }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container == null) return;

    let chart: ECharts | undefined;
    let observer: ResizeObserver | undefined;
    let disposed = false;

    // echarts sólo en el navegador: import dinámico para no cargarlo en el SSR
    import("echarts").then((echarts) => {
      if (disposed) return;
      chart = echarts.init(container, undefined, { renderer: "canvas" });
      chart.setOption(chartOption(points));
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(container);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      chart?.dispose();
    };
  }, [points]);

  return <div ref={containerRef} style={playbackStyles.chart} />;
}

// --- Resumen numérico: los valores del tooltip también se leen sin hover ---

function describe(points: Points | null) {
  if (points == null || points.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const [, p] of points) {
    if (p < min) min = p;
    if (p > max) max = p;
    sum += p;
  }
  return {
    min: formatNumber(min, 1),
    max: formatNumber(max, 1),
    mean: formatNumber(sum / points.length, 2),
  };
}

function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M12 3v12m0 0-5-5m5 5 5-5M4 20h16" stroke={INK} strokeWidth="2.5" strokeLinecap="square" />
    </svg>
  );
}

const playbackStyles = {
  chart: { flex: 1, minHeight: 0, width: "100%" },
  hint: {
    fontFamily: MONO,
    fontSize: 10,
    color: "#888",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
  },
  placeholder: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "2px dashed rgba(17,17,17,0.3)",
    padding: 24,
  },
  placeholderText: {
    fontFamily: MONO,
    fontSize: 12,
    color: "#666",
    textAlign: "center" as const,
    maxWidth: 460,
    lineHeight: 1.6,
    margin: 0,
  },
} satisfies Record<string, React.CSSProperties>;
