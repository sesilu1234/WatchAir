"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ECharts } from "echarts";
import { ACCENT, INK, MONO, PAPER } from "../../theme";
import { fetchRecordingSamples, recordingDataUrl, type Recording } from "../../lib/api";
import {
  durationSeconds,
  formatDate,
  formatClock,
  formatNumber,
  formatTime,
  recordingName,
} from "../../lib/format";
import { useCompact } from "../../lib/useCompact";
import { useFullscreen } from "../../lib/useFullscreen";
import {
  chartOption,
  chartViewPatch,
  chartYPatch,
  defaultRange,
  formatRange,
  formatWindow,
  rangeIndex,
  visibleSeconds,
  Y_RANGES,
  type ChartView,
  type Points,
} from "./chartOption";
import { BackLink, Stat, mobile, styles } from "./ui";

// Vista de una grabación ya terminada: no hay tiempo real, se pinta el CSV entero.
export default function RecordingPlayback({ recording }: { recording: Recording }) {
  const [points, setPoints] = useState<Points | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Escala del eje Y: se propone una al cargar y a partir de ahí manda el usuario.
  const [chosenRange, setChosenRange] = useState<number | null>(null);
  // Segundos de grabación que caben ahora mismo en pantalla (lo dice la gráfica).
  const [visible, setVisible] = useState<number | null>(null);
  const compact = useCompact();
  // La tarjeta entera es lo que se va a pantalla completa: así el título y el
  // botón de salir siguen ahí dentro. En el móvil, además, en horizontal: en
  // vertical la gráfica queda demasiado estrecha para leer nada.
  const cardRef = useRef<HTMLElement>(null);
  const { active: fullscreen, toggle: toggleFullscreen } = useFullscreen(cardRef, {
    landscape: compact,
  });

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
  // Sin estado intermedio: mientras el usuario no toque los botones vale la
  // escala propuesta, y así la gráfica ya nace con la definitiva.
  const suggested = useMemo(() => (points?.length ? defaultRange(points) : null), [points]);
  const range = chosenRange ?? suggested;

  return (
    <main style={{ ...styles.main, ...(compact ? mobile.main : null) }}>
      <BackLink />
      <header style={{ ...styles.header, ...(compact ? mobile.header : null) }}>
        <h1 style={{ ...styles.title, ...(compact ? mobile.title : null) }}>
          {recordingName(recording.started_at)}
        </h1>
        <p style={styles.subtitle}>
          {formatDate(started)} · {formatTime(started)} · {recording.client}
        </p>
      </header>

      <div style={{ ...styles.bar, ...(compact ? mobile.bar : null) }}>
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
          style={{
            ...styles.button,
            ...styles.buttonAccent,
            marginLeft: "auto",
            ...(compact ? mobile.button : null),
          }}
        >
          <DownloadIcon />
          Descargar CSV
        </a>
      </div>

      <section
        ref={cardRef}
        style={{
          ...styles.card,
          ...(compact ? mobile.card : null),
          ...(fullscreen ? playbackStyles.cardFullscreen : null),
        }}
      >
        <div style={{ ...styles.cardHeader, ...(compact ? mobile.cardHeader : null) }}>
          <span style={styles.cardTitle}>Flujo de aire (Presión) · Pa</span>
          <div style={playbackStyles.headerActions}>
            <span style={playbackStyles.hint}>{zoomHint(compact, fullscreen)}</span>
            {visible != null && <Readout label="Ventana" value={formatWindow(visible)} />}
            {range != null && <ScaleControls range={range} onChange={setChosenRange} />}
            <FullscreenButton active={fullscreen} onToggle={toggleFullscreen} />
          </div>
        </div>
        <ChartArea
          points={points}
          error={error}
          view={{ compact, fullscreen }}
          range={range}
          onWindow={setVisible}
        />
      </section>
    </main>
  );
}

// Dentro de la tarjeta el arrastre está desactivado para poder hacer scroll en
// la página (ver chartOption), así que el gesto que se sugiere no es el mismo.
function zoomHint(compact: boolean, fullscreen: boolean): string {
  if (!compact) return "Rueda o arrastra para hacer zoom";
  return fullscreen ? "Pellizca y arrastra la gráfica" : "Pellizca para hacer zoom";
}

function ChartArea({
  points,
  error,
  view,
  range,
  onWindow,
}: {
  points: Points | null;
  error: string | null;
  view: ChartView;
  range: number | null;
  onWindow: (seconds: number) => void;
}) {
  const inline = view.compact && !view.fullscreen;
  if (error != null)
    return <Placeholder text={`No se pudieron cargar los datos: ${error}`} inline={inline} />;
  if (points == null) return <Placeholder text="Cargando muestras…" inline={inline} />;
  if (points.length === 0 || range == null)
    return <Placeholder text="Esta grabación no tiene ninguna muestra." inline={inline} />;
  return (
    <PressureChart
      points={points}
      range={range}
      onWindow={onWindow}
      compact={view.compact}
      fullscreen={view.fullscreen}
    />
  );
}

function Placeholder({ text, inline }: { text: string; inline: boolean }) {
  return (
    <div style={{ ...playbackStyles.placeholder, ...(inline ? playbackStyles.boxCompact : null) }}>
      <p style={playbackStyles.placeholderText}>{text}</p>
    </div>
  );
}

// Rótulo de cabecera: etiqueta pequeña + valor en mono, como los de la barra.
function Readout({ label, value }: { label: string; value: string }) {
  return (
    <span style={playbackStyles.readout}>
      <span style={playbackStyles.readoutLabel}>{label}</span>
      <span style={playbackStyles.readoutValue}>{value}</span>
    </span>
  );
}

// − aleja (más Pa a la vista), + acerca (menos Pa): siempre saltando de escalón
// en escalón, y siempre simétrico respecto al cero.
function ScaleControls({ range, onChange }: { range: number; onChange: (r: number) => void }) {
  const i = rangeIndex(range);

  return (
    <span style={playbackStyles.readout}>
      <span style={playbackStyles.readoutLabel}>Escala</span>
      <StepButton
        label="−"
        title="Alejar: más rango en el eje Y"
        disabled={i >= Y_RANGES.length - 1}
        onClick={() => onChange(Y_RANGES[i + 1])}
      />
      <span style={{ ...playbackStyles.readoutValue, ...playbackStyles.scaleValue }}>
        {formatRange(range)}
      </span>
      <StepButton
        label="+"
        title="Acercar: menos rango en el eje Y"
        disabled={i <= 0}
        onClick={() => onChange(Y_RANGES[i - 1])}
      />
    </span>
  );
}

function StepButton({
  label,
  title,
  disabled,
  onClick,
}: {
  label: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      style={{
        ...playbackStyles.stepButton,
        ...(hover && !disabled ? playbackStyles.stepButtonHover : null),
        ...(disabled ? playbackStyles.stepButtonOff : null),
      }}
    >
      {label}
    </button>
  );
}

// Sin dependencias nuevas: la API de pantalla completa del navegador sobre la
// tarjeta. Donde no exista (Safari del iPhone) el estado por sí solo ya la deja
// ocupando toda la ventana.
function FullscreenButton({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const [hover, setHover] = useState(false);

  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={active ? "Salir de pantalla completa" : "Ver a pantalla completa"}
      style={{
        ...playbackStyles.fullscreenButton,
        ...(hover ? playbackStyles.fullscreenButtonHover : null),
      }}
    >
      <FullscreenIcon active={active} />
      {active ? "Salir" : "Ampliar"}
    </button>
  );
}

// --- Gráfica ECharts ---

function PressureChart({
  points,
  range,
  onWindow,
  compact,
  fullscreen,
}: {
  points: Points;
  range: number;
  onWindow: (seconds: number) => void;
  compact: boolean;
  fullscreen: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  // echarts se carga de forma asíncrona: cuando termine puede que la vista o la
  // escala ya hayan cambiado, así que las lee de aquí y no del closure.
  const viewRef = useRef<ChartView>({ compact, fullscreen });
  const rangeRef = useRef(range);

  useEffect(() => {
    const container = containerRef.current;
    if (container == null) return;

    let chart: ECharts | undefined;
    let observer: ResizeObserver | undefined;
    let disposed = false;
    const span = points[points.length - 1][0] - points[0][0];

    // echarts sólo en el navegador: import dinámico para no cargarlo en el SSR
    import("echarts").then((echarts) => {
      if (disposed) return;
      const instance = echarts.init(container, undefined, { renderer: "canvas" });
      chart = instance;
      chartRef.current = instance;
      instance.setOption(chartOption(points, viewRef.current, rangeRef.current));
      // Al arrancar se ve la grabación entera; después, lo que deje el zoom.
      const report = () => onWindow(visibleSeconds(instance, span));
      instance.on("dataZoom", report);
      report();
      // También cubre el cambio de tamaño al entrar y salir de pantalla completa.
      observer = new ResizeObserver(() => instance.resize());
      observer.observe(container);
    });

    return () => {
      disposed = true;
      chartRef.current = null;
      observer?.disconnect();
      chart?.dispose();
    };
  }, [points, onWindow]);

  // setOption parcial: reajusta márgenes y gestos sin repintar la serie ni
  // perder el zoom actual.
  useEffect(() => {
    viewRef.current = { compact, fullscreen };
    chartRef.current?.setOption(chartViewPatch(viewRef.current));
  }, [compact, fullscreen]);

  // Ídem con la escala del eje Y: sólo cambian los límites del eje.
  useEffect(() => {
    rangeRef.current = range;
    chartRef.current?.setOption(chartYPatch(range));
  }, [range]);

  return (
    <div
      ref={containerRef}
      style={{
        ...playbackStyles.chart,
        ...(compact && !fullscreen ? playbackStyles.boxCompact : null),
      }}
    />
  );
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

// Cuatro esquinas que se abren o se cierran, en la línea del resto de iconos.
function FullscreenIcon({ active }: { active: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path
        d={
          active
            ? "M10 4v6H4M14 4v6h6M10 20v-6H4M14 20v-6h6"
            : "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
        }
        stroke={INK}
        strokeWidth="2.5"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

const playbackStyles = {
  chart: { flex: 1, minHeight: 0, width: "100%" },
  // En el móvil la tarjeta no se estira, así que la gráfica necesita alto propio.
  boxCompact: { flex: "none", height: "clamp(260px, 48dvh, 460px)" },
  // Vale tanto para la pantalla completa nativa como para el apaño de los
  // navegadores que no la soportan: en ambos casos ocupa la ventana entera.
  cardFullscreen: {
    position: "fixed" as const,
    inset: 0,
    zIndex: 90,
    margin: 0,
    width: "100%",
    height: "100%",
    maxHeight: "none",
    flex: "none",
    boxShadow: "none",
    padding: 14,
    paddingBottom: "max(14px, env(safe-area-inset-bottom))",
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginLeft: "auto",
    flexWrap: "wrap" as const,
  },
  // El borde va desglosado (no `border: …`) porque el hover sólo cambia el
  // color: mezclar la forma corta con la larga rompe el estilo al re-renderizar.
  fullscreenButton: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    background: PAPER,
    color: INK,
    borderWidth: 2,
    borderStyle: "solid" as const,
    borderColor: INK,
    boxShadow: `3px 3px 0 ${INK}`,
    padding: "7px 12px",
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 800,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    cursor: "pointer",
    transition: "box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease",
  },
  fullscreenButtonHover: {
    borderColor: ACCENT,
    boxShadow: `4px 4px 0 ${ACCENT}`,
    transform: "translate(-1px, -1px)",
  },
  readout: { display: "flex", alignItems: "center", gap: 6 },
  readoutLabel: {
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "#888",
  },
  readoutValue: { fontFamily: MONO, fontSize: 12, fontWeight: 800, color: INK },
  // Ancho fijo: al cambiar de escalón los botones no se mueven de sitio.
  scaleValue: { minWidth: 72, textAlign: "center" as const },
  stepButton: {
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: PAPER,
    color: INK,
    borderWidth: 2,
    borderStyle: "solid" as const,
    borderColor: INK,
    boxShadow: `2px 2px 0 ${INK}`,
    padding: 0,
    fontFamily: MONO,
    fontSize: 15,
    fontWeight: 900,
    lineHeight: 1,
    cursor: "pointer",
    transition: "box-shadow 0.15s ease, border-color 0.15s ease",
  },
  stepButtonHover: { borderColor: ACCENT, boxShadow: `3px 3px 0 ${ACCENT}` },
  stepButtonOff: { opacity: 0.3, cursor: "default" },
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
