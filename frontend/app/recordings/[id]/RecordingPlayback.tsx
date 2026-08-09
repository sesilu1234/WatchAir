"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { ACCENT, INK, MONO, PAPER, SIGNAL_NEG, SIGNAL_POS } from "../../theme";
import { fetchRecordingSamples, type Recording } from "../../lib/api";
import {
  displayName,
  durationSeconds,
  formatDate,
  formatClock,
  formatNumber,
  formatTime,
} from "../../lib/format";
import { useCompact } from "../../lib/useCompact";
import { useFullscreen } from "../../lib/useFullscreen";
import {
  alignedData,
  chartCss,
  clampWindow,
  defaultRange,
  formatRange,
  formatVisible,
  mainOpts,
  navOpts,
  rangeIndex,
  toSignal,
  tooltipTime,
  Y_RANGES,
  type ChartView,
  type Points,
  type Signal,
  type TimeAxis,
  type TimeMode,
  type VisibleRange,
} from "./chart";
import {
  analyseBreathing,
  phaseSplit,
  pressureHistogram,
  type Breathing,
  type Histogram,
  type PhaseSplit,
} from "./breathing";
import { BackLink, Stat, mobile, styles } from "./ui";

// Velocidad del desplazamiento con las flechas, en ventanas visibles por
// segundo: 0,8 = la pantalla entera tarda segundo y cuarto en pasar. Va en
// fracción de lo que se ve, así que se siente igual de suave con la grabación
// entera delante que con diez segundos.
const PAN_SPEED = 0.6;
const PAN_FAST = 3; // con Shift
const PAN_TAP = 0.04; // empujón del toque corto, antes de que arranque el bucle

// Flechas ↑/↓: abrir y cerrar la ventana de tiempo. Va en exponencial —la
// ventana se multiplica, no se le suman segundos— porque el zoom se percibe en
// proporción: pasar de 10 s a 5 s se nota igual que pasar de dos horas a una. En
// segundos fijos, el mismo paso sería imperceptible alejado e inservible cerca.
//
// ZOOM_SPEED es el exponente por segundo: 1,1 es multiplicar por 3 cada segundo.
const ZOOM_SPEED = 1.1;
const ZOOM_TAP = 0.22; // ~1,25× del toque corto

// Tope de lo que se le deja valer a un frame. Está para el caso de volver de
// otra pestaña: allí no corren los frames, así que al volver `now - previous`
// son segundos enteros y sin tope la gráfica pegaría un salto hasta el fondo.
//
// Generoso a propósito. Con un tope bajo, un frame que tarde más que él avanza
// sólo lo que marca el tope y no lo que ha tardado de verdad, así que la gráfica
// se arrastra a cámara lenta justo cuando va apurada — y encima parece que el
// desplazamiento es lento cuando lo que pasa es que se están perdiendo frames.
// Un cuarto de segundo de recuperación no se ve; el hueco de una pestaña en
// segundo plano se mide en segundos y sigue topado.
const MAX_FRAME = 0.25;

// El rótulo de la ventana se refresca a 10 Hz y no en cada frame: es texto, y
// pedirle a React que repinte la cabecera sesenta veces por segundo no cambia
// nada de lo que se lee.
const READOUT_MS = 100;

// Vista de una grabación ya terminada: no hay tiempo real, se pinta el CSV entero.
export default function RecordingPlayback({ recording }: { recording: Recording }) {
  const [points, setPoints] = useState<Points | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Escala del eje Y: se propone una al cargar y a partir de ahí manda el usuario.
  const [chosenRange, setChosenRange] = useState<number | null>(null);
  // Tramo de la grabación que se está viendo ahora mismo (lo dice la gráfica).
  const [visible, setVisible] = useState<VisibleRange | null>(null);
  // Rótulos del eje X: duración desde el principio, o la hora real del reloj.
  const [timeMode, setTimeMode] = useState<TimeMode>("elapsed");
  const compact = useCompact();
  // La tarjeta entera es lo que se va a pantalla completa: así el título y el
  // botón de salir siguen ahí dentro. En el móvil, además, en horizontal: en
  // vertical la gráfica queda demasiado estrecha para leer nada.
  const cardRef = useRef<HTMLElement>(null);
  const { active: fullscreen, toggle: toggleFullscreen } = useFullscreen(cardRef, {
    landscape: compact,
  });

  // page.tsx monta este componente con key={uuid}, así que al cambiar de
  // grabación se remonta y el estado arranca limpio: aquí sólo hace falta
  // pedir los datos.
  useEffect(() => {
    let cancelled = false;
    fetchRecordingSamples(recording.uuid)
      .then((p) => !cancelled && setPoints(p))
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [recording.uuid]);

  const started = new Date(recording.started_at);
  const name = displayName(recording);
  const seconds = durationSeconds(recording.started_at, recording.ended_at);
  const summary = useMemo(() => describe(points), [points]);
  const breathing = useMemo(() => analyseBreathing(points), [points]);
  const histogram = useMemo(() => (points ? pressureHistogram(points) : null), [points]);
  const split = useMemo(() => (points ? phaseSplit(points) : null), [points]);
  // Sobre `started_at` y no sobre `started`: un Date nuevo en cada render haría
  // que esto cambiase de identidad siempre y la gráfica se reparchease en vano.
  const time = useMemo<TimeAxis>(
    () => ({ mode: timeMode, startedMs: Date.parse(recording.started_at) }),
    [timeMode, recording.started_at],
  );
  // Cuenta muestras reales: los puntos y=null son marcadores de hueco, no datos.
  const sampleCount = useMemo(() => points?.filter(([, p]) => p !== null).length ?? null, [points]);
  // Sin estado intermedio: mientras el usuario no toque los botones vale la
  // escala propuesta, y así la gráfica ya nace con la definitiva.
  const suggested = useMemo(() => (points?.length ? defaultRange(points) : null), [points]);
  const range = chosenRange ?? suggested;

  // Los datos en las dos columnas que quiere uplot, una sola vez. A partir de
  // aquí se le dan enteros: uplot agrupa por columna de píxel mientras dibuja,
  // así que no hay que reducirlos ni recortarlos por ventana (ver chart.ts).
  const signal = useMemo(() => (points?.length ? toSignal(points) : null), [points]);

  return (
    <main style={{ ...styles.main, ...(compact ? mobile.main : null) }}>
      <BackLink />
      <header style={{ ...styles.header, ...(compact ? mobile.header : null) }}>
        <div>
          <h1 style={{ ...styles.title, ...(compact ? mobile.title : null) }}>{name}</h1>
          <p style={styles.subtitle}>
            {formatDate(started)} · {formatTime(started)} · {recording.username}
          </p>
        </div>
        <a
          href={`/api/recordings/${recording.uuid}/data?format=csv`}
          download={`${name}.csv`}
          style={{
            ...styles.button,
            ...styles.buttonAccent,
            ...(compact ? mobile.button : null),
          }}
        >
          <DownloadIcon />
          Descargar CSV
        </a>
      </header>

      <div style={{ ...styles.bar, ...(compact ? mobile.bar : null) }}>
        <Stat label="Duración" value={seconds == null ? "—" : formatClock(seconds)} />
        <Stat label="Muestras" value={sampleCount == null ? "—" : formatNumber(sampleCount)} />
        <Stat
          label="Frecuencia"
          value={seconds && sampleCount ? `${formatNumber(sampleCount / seconds, 1)} Hz` : "—"}
        />
        <Stat label="Mín / Máx" value={summary ? `${summary.min} / ${summary.max} Pa` : "—"} />
        <Stat label="Media" value={summary ? `${summary.mean} Pa` : "—"} />
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
            {visible != null && (
              <Readout label="Ventana" value={formatVisible(visible, time)} wide />
            )}
            <TimeModeControls mode={timeMode} onChange={setTimeMode} />
            {range != null && <ScaleControls range={range} onChange={setChosenRange} />}
            <FullscreenButton active={fullscreen} onToggle={toggleFullscreen} />
          </div>
        </div>
        <ChartArea
          signal={signal}
          loading={points == null}
          error={error}
          view={{ compact, fullscreen }}
          range={range}
          time={time}
          onWindow={setVisible}
        />
      </section>

      <BreathingSection
        breathing={breathing}
        histogram={histogram}
        split={split}
        loading={points == null}
      />
    </main>
  );
}

// --- Análisis de la respiración ---
//
// Todo sale de las mismas muestras que pinta la gráfica (ver breathing.ts): no
// hay ninguna llamada extra ni nada guardado en el servidor.
//
// Los dos gráficos comparten el mismo par de colores y el mismo significado:
// el color sólo dice de qué lado del cero está la señal, nunca cuánto vale.
// El cuánto lo dice el alto de la barra o el tamaño de la porción.

// memo: desplazarse con las flechas dispara un evento de zoom por frame, y sin
// esto la sección entera se repintaría 60 veces por segundo para no cambiar
// nada. Sus cuatro props salen de useMemo, así que la comparación siempre acierta.
const BreathingSection = memo(function BreathingSection({
  breathing,
  histogram,
  split,
  loading,
}: {
  breathing: Breathing | null;
  histogram: Histogram | null;
  split: PhaseSplit | null;
  loading: boolean;
}) {
  const compact = useCompact();

  return (
    <section style={{ ...styles.section, ...(compact ? mobile.section : null) }}>
      <div style={styles.sectionHead}>
        <span style={styles.sectionTitle}>Análisis de la respiración</span>
        <p style={styles.sectionNote}>Calculado sobre la señal · cruces por cero</p>
      </div>

      {breathing == null ? (
        <p style={playbackStyles.sectionEmpty}>
          {loading
            ? "Calculando…"
            : "No se han detectado ciclos respiratorios claros en esta señal."}
        </p>
      ) : (
        <>
          {/* Tres y no seis: "ciclo medio" era 60/rpm otra vez dicho, y el ratio
              de fases es justo lo que enseña la tarta de aquí abajo. */}
          <div style={{ ...styles.bar, ...(compact ? mobile.bar : null) }}>
            <Stat label="Frecuencia respiratoria" value={`${formatNumber(breathing.rpm, 1)} rpm`} />
            <Stat label="Amplitud pico a pico" value={`${formatNumber(breathing.amplitude, 1)} Pa`} />
            <Stat label="Regularidad" value={`± ${formatNumber(breathing.cycleSpread, 1)} s`} />
          </div>

          <div style={{ ...playbackStyles.plots, ...(compact ? playbackStyles.plotsCompact : null) }}>
            {split && <PhaseSplitPlot split={split} />}
            {histogram && <PressureHistogramPlot histogram={histogram} />}
          </div>
        </>
      )}
    </section>
  );
});

// Leyenda de los dos gráficos: el color no dice nada por sí solo, y menos con
// este par (rojo y azul tienen casi la misma claridad, ver theme.ts). Vive en la
// cabecera del histograma, que es el único que no rotula sus propios colores.
function PhaseLegend() {
  return (
    <span style={playbackStyles.legend}>
      <span style={playbackStyles.legendItem}>
        <span style={{ ...playbackStyles.legendSwatch, background: SIGNAL_POS }} />
        Inspiración +
      </span>
      <span style={playbackStyles.legendItem}>
        <span style={{ ...playbackStyles.legendSwatch, background: SIGNAL_NEG }} />
        Espiración −
      </span>
    </span>
  );
}

function Plot({
  title,
  note,
  children,
}: {
  title: string;
  note: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <figure style={playbackStyles.plot}>
      <figcaption style={playbackStyles.plotHead}>
        <span style={playbackStyles.plotTitle}>{title}</span>
        <span style={playbackStyles.plotNote}>{note}</span>
      </figcaption>
      {children}
    </figure>
  );
}

// Cuánto del tiempo se pasó a cada lado del cero. Es la misma pregunta que
// respondía el "ratio fase + / −", pero en porcentaje y de un vistazo.
//
// Sin librería: una tarta de dos porciones es un conic-gradient. Los números van
// escritos al lado, que es lo que de verdad se lee — el círculo sólo dice si
// está repartido o torcido.
function PhaseSplitPlot({ split }: { split: PhaseSplit }) {
  const positive = split.positive * 100;
  const label = (fraction: number) => `${formatNumber(fraction * 100, 1)} %`;

  return (
    <Plot title="Reparto del tiempo" note="">
      <div style={playbackStyles.pieRow}>
        <span
          style={{
            ...playbackStyles.pie,
            background: `conic-gradient(${SIGNAL_POS} 0 ${positive}%, ${SIGNAL_NEG} ${positive}% 100%)`,
          }}
          title={`Inspiración ${label(split.positive)} · Espiración ${label(split.negative)}`}
        />
        <div style={playbackStyles.pieKeys}>
          <PieKey color={SIGNAL_POS} label="Inspiración" value={label(split.positive)} />
          <PieKey color={SIGNAL_NEG} label="Espiración" value={label(split.negative)} />
        </div>
      </div>
    </Plot>
  );
}

// La cifra debajo de su etiqueta y alineada con ella, no al otro lado de la
// tarjeta: es el dato, y tiene que leerse junto a lo que nombra.
function PieKey({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div style={playbackStyles.pieKey}>
      <span style={playbackStyles.pieKeyHead}>
        <span style={{ ...playbackStyles.legendSwatch, background: color }} />
        {label}
      </span>
      <span style={playbackStyles.pieKeyValue}>{value}</span>
    </div>
  );
}

// Cuánto tiempo pasó la señal en cada nivel de presión. Una respiración normal
// sale como dos lomas simétricas; si sale torcida, es que un lado dura o pega
// más que el otro.
function PressureHistogramPlot({ histogram }: { histogram: Histogram }) {
  const { counts, limit, peak } = histogram;
  const step = (2 * limit) / counts.length;

  // La nota "±X Pa" que había aquí ya la dice el eje de abajo: el hueco es para
  // la leyenda, que es lo único que explica los colores de los dos gráficos.
  return (
    <Plot title="Distribución de presión" note={<PhaseLegend />}>
      <div style={playbackStyles.histogram}>
        {counts.map((n, i) => {
          const from = -limit + i * step;
          return (
            <span
              key={i}
              style={{
                ...playbackStyles.bar,
                background: from < 0 ? SIGNAL_NEG : SIGNAL_POS,
                height: `${Math.max(1, (n / peak) * 100)}%`,
                flex: "1 1 0",
                minWidth: 2,
              }}
              title={`${formatNumber(from, 1)} … ${formatNumber(from + step, 1)} Pa · ${formatNumber(n)} muestras`}
            />
          );
        })}
      </div>
      <div style={playbackStyles.axis}>
        <span>{`−${formatNumber(limit, 1)}`}</span>
        <span>0</span>
        <span>{`+${formatNumber(limit, 1)}`}</span>
      </div>
    </Plot>
  );
}

// Dentro de la tarjeta el arrastre está desactivado para poder hacer scroll en
// la página (ver chartOption), así que el gesto que se sugiere no es el mismo.
function zoomHint(compact: boolean, fullscreen: boolean): string {
  if (compact) return fullscreen ? "Pellizca y arrastra la gráfica" : "Pellizca para hacer zoom";
  // Las flechas sólo funcionan a pantalla completa, así que sólo se anuncian ahí.
  return fullscreen ? "Flechas para moverte y ampliar · rueda o arrastra" : "Rueda o arrastra para hacer zoom";
}

function ChartArea({
  signal,
  loading,
  error,
  view,
  range,
  time,
  onWindow,
}: {
  signal: Signal | null;
  loading: boolean;
  error: string | null;
  view: ChartView;
  range: number | null;
  time: TimeAxis;
  onWindow: (range: VisibleRange) => void;
}) {
  const inline = view.compact && !view.fullscreen;
  if (error != null)
    return <Placeholder text={`No se pudieron cargar los datos: ${error}`} inline={inline} />;
  if (loading) return <Placeholder text="Cargando muestras…" inline={inline} />;
  if (signal == null || range == null)
    return <Placeholder text="Esta grabación no tiene ninguna muestra." inline={inline} />;
  return (
    <PressureChart
      signal={signal}
      range={range}
      time={time}
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
// `wide` reserva el ancho: el de la ventana cambia con cada paso del desplazamiento
// y sin un ancho fijo iría empujando a los botones de al lado.
function Readout({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <span style={playbackStyles.readout}>
      <span style={playbackStyles.readoutLabel}>{label}</span>
      <span style={{ ...playbackStyles.readoutValue, ...(wide ? playbackStyles.readoutWide : null) }}>
        {value}
      </span>
    </span>
  );
}

// Duración desde el principio, o la hora del reloj. Lo mismo pintado, sólo
// cambia cómo se rotula: a los 20 min de una grabación que empezó a las 22:00,
// el eje pone "20:00" o "22:20".
function TimeModeControls({
  mode,
  onChange,
}: {
  mode: TimeMode;
  onChange: (mode: TimeMode) => void;
}) {
  return (
    <span style={playbackStyles.readout}>
      <span style={playbackStyles.readoutLabel}>Eje X</span>
      <ModeButton
        label="Duración"
        title="Rotular el eje con el tiempo desde el inicio de la grabación"
        active={mode === "elapsed"}
        onClick={() => onChange("elapsed")}
      />
      <ModeButton
        label="Hora"
        title="Rotular el eje con la hora real a la que pasó"
        active={mode === "clock"}
        onClick={() => onChange("clock")}
      />
    </span>
  );
}

function ModeButton({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={title}
      aria-pressed={active}
      style={{
        ...playbackStyles.modeButton,
        ...(active ? playbackStyles.modeButtonOn : null),
        ...(hover && !active ? playbackStyles.stepButtonHover : null),
      }}
    >
      {label}
    </button>
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

// --- Gráfica uPlot ---
//
// uplot y no echarts por un motivo concreto: al dibujar agrupa los puntos por
// columna de píxel y se queda con el mínimo y el máximo de cada una. Con 800.000
// muestras en una pantalla de 1.500 píxeles eso son ~3.000 trazos en vez de
// 800.000, y sale de su propio bucle de dibujado: no hay que prepararle los
// datos, ni reducirlos, ni recortárselos por ventana. Se le dan enteros.

const NAV_HEIGHT = 54; // alto de la tira de navegación
const ZOOM_STEP = 1.35; // cuánto abre o cierra la rueda de una vez
const MIN_WINDOW = 1; // segundos: el suelo del zoom, para no perderse dentro

function PressureChart({
  signal,
  range,
  time,
  onWindow,
  compact,
  fullscreen,
}: {
  signal: Signal;
  range: number;
  time: TimeAxis;
  onWindow: (range: VisibleRange) => void;
  compact: boolean;
  fullscreen: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipValueRef = useRef<HTMLSpanElement>(null);
  const tipTimeRef = useRef<HTMLSpanElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const navPlotRef = useRef<uPlot | null>(null);

  // uplot se monta una vez y sus opciones se construyen una vez. Lo que puede
  // cambiar después —la escala Y, los rótulos del eje X, el tramo visible— lo
  // leen de estas referencias cada vez que dibuja, así que cambiarlo es tocar la
  // referencia y pedir un repintado.
  const rangeRef = useRef(range);
  const timeRef = useRef(time);
  const windowRef = useRef<VisibleRange>({ from: signal.firstT, to: signal.lastT });

  useEffect(() => {
    const plotHost = plotRef.current;
    const navHost = navRef.current;
    const wrap = wrapRef.current;
    if (plotHost == null || navHost == null || wrap == null) return;

    let chart: uPlot | undefined;
    let nav: uPlot | undefined;
    let observer: ResizeObserver | undefined;
    let disposed = false;
    let readout: number | undefined;
    let cleanupExtras: (() => void) | undefined;

    // uplot toca `document` al cargarse, así que import dinámico: en el SSR no
    // hay documento que tocar.
    import("uplot").then((mod) => {
      if (disposed) return;
      const UPlot = mod.default;
      const data = alignedData(signal);
      const { firstT, lastT } = signal;

      // El rótulo de la ventana se refresca a 10 Hz y no en cada frame: es
      // texto, y repintar la cabecera sesenta veces por segundo no cambia nada
      // de lo que se lee. Siempre cae uno al final, así que nunca se queda atrás.
      const scheduleReport = () => {
        if (readout != null) return;
        readout = window.setTimeout(() => {
          readout = undefined;
          onWindow({ ...windowRef.current });
        }, READOUT_MS);
      };

      const onScale = () => {
        const scale = chart?.scales.x;
        if (scale?.min == null || scale?.max == null) return;
        windowRef.current = { from: scale.min, to: scale.max };
        nav?.redraw(); // la tira de abajo tiene que mover su marca
        scheduleReport();
      };

      // Tooltip propio: uplot trae una leyenda, pero es una tabla y aquí hace
      // falta el valor grande y la hora pequeña debajo, como el resto de la
      // página. Se actualiza el texto de dos nodos ya creados, sin rehacer HTML.
      const onCursor = () => {
        const tip = tipRef.current;
        if (chart == null || tip == null) return;
        const idx = chart.cursor.idx;
        if (idx == null) {
          tip.style.visibility = "hidden";
          return;
        }
        const p = signal.ys[idx];
        if (tipValueRef.current != null)
          tipValueRef.current.textContent = p === null ? "—" : `${p.toFixed(2)} Pa`;
        if (tipTimeRef.current != null)
          tipTimeRef.current.textContent = tooltipTime(signal.xs[idx], timeRef.current);

        tip.style.visibility = "visible";
        const left = chart.cursor.left ?? 0;
        const top = chart.cursor.top ?? 0;
        // Se pasa al otro lado del cursor antes de salirse por la derecha.
        const flip = left + 16 + tip.offsetWidth > chart.over.clientWidth;
        tip.style.left = `${chart.over.offsetLeft + left + (flip ? -tip.offsetWidth - 14 : 14)}px`;
        tip.style.top = `${chart.over.offsetTop + top - 12}px`;
      };

      chart = new UPlot(
        mainOpts({
          width: Math.max(plotHost.clientWidth, 1),
          height: Math.max(plotHost.clientHeight, 1),
          compact,
          read: () => ({ range: rangeRef.current, time: timeRef.current }),
          onScale,
          onCursor,
        }),
        data,
        plotHost,
      );
      chartRef.current = chart;

      // La tira comparte los mismos arrays: no hay una segunda copia de nada.
      nav = new UPlot(
        navOpts({
          width: Math.max(navHost.clientWidth, 1),
          height: NAV_HEIGHT,
          read: () => ({ range: rangeRef.current, window: windowRef.current }),
        }),
        data,
        navHost,
      );
      navPlotRef.current = nav;

      // La rueda hace zoom alrededor del puntero, que es lo que se espera: el
      // instante que tienes debajo del ratón se queda donde está.
      const onWheel = (event: WheelEvent) => {
        if (chart?.scales.x.min == null || chart.scales.x.max == null) return;
        event.preventDefault();
        const { min, max } = chart.scales.x;
        const rect = chart.over.getBoundingClientRect();
        const at = min + ((event.clientX - rect.left) / rect.width) * (max - min);
        const grow = event.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
        const width = Math.min(Math.max((max - min) * grow, MIN_WINDOW), lastT - firstT);
        const share = (at - min) / (max - min);
        const next = clampWindow(at - width * share, at + width * (1 - share), firstT, lastT);
        chart.setScale("x", { min: next.from, max: next.to });
      };
      chart.over.addEventListener("wheel", onWheel, { passive: false });

      // En la tira, pinchar o arrastrar lleva la ventana a ese punto sin cambiar
      // el zoom. Es la forma rápida de cruzar una grabación de nueve horas.
      let dragging = false;
      const jump = (clientX: number) => {
        if (chart == null || nav == null) return;
        const rect = nav.over.getBoundingClientRect();
        const at = firstT + ((clientX - rect.left) / rect.width) * (lastT - firstT);
        const { from, to } = windowRef.current;
        const half = (to - from) / 2;
        const next = clampWindow(at - half, at + half, firstT, lastT);
        chart.setScale("x", { min: next.from, max: next.to });
      };
      const onNavDown = (event: PointerEvent) => {
        dragging = true;
        nav?.over.setPointerCapture(event.pointerId);
        jump(event.clientX);
      };
      const onNavMove = (event: PointerEvent) => dragging && jump(event.clientX);
      const onNavUp = () => {
        dragging = false;
      };
      nav.over.addEventListener("pointerdown", onNavDown);
      nav.over.addEventListener("pointermove", onNavMove);
      nav.over.addEventListener("pointerup", onNavUp);
      nav.over.addEventListener("pointercancel", onNavUp);

      onScale();
      onWindow({ ...windowRef.current });

      // Cubre también el cambio de tamaño al entrar y salir de pantalla completa.
      observer = new ResizeObserver(() => {
        chart?.setSize({
          width: Math.max(plotHost.clientWidth, 1),
          height: Math.max(plotHost.clientHeight, 1),
        });
        nav?.setSize({ width: Math.max(navHost.clientWidth, 1), height: NAV_HEIGHT });
      });
      observer.observe(wrap);

      cleanupExtras = () => {
        chart?.over.removeEventListener("wheel", onWheel);
        nav?.over.removeEventListener("pointerdown", onNavDown);
        nav?.over.removeEventListener("pointermove", onNavMove);
        nav?.over.removeEventListener("pointerup", onNavUp);
        nav?.over.removeEventListener("pointercancel", onNavUp);
      };
    });

    return () => {
      disposed = true;
      chartRef.current = null;
      navPlotRef.current = null;
      if (readout != null) clearTimeout(readout);
      cleanupExtras?.();
      observer?.disconnect();
      chart?.destroy();
      nav?.destroy();
    };
  }, [signal, onWindow, compact]);

  // Cambiar la escala del eje Y no toca los datos ni el zoom del eje X: se fija
  // la escala nueva y se repinta.
  useEffect(() => {
    rangeRef.current = range;
    chartRef.current?.setScale("y", { min: -range, max: range });
    navPlotRef.current?.setScale("y", { min: -range, max: range });
  }, [range]);

  // Pasar de duración a hora real es reescribir rótulos: mismos datos, mismo
  // zoom, misma serie.
  //
  // El segundo argumento no sobra. `redraw()` a secas sólo vuelve a dibujar lo
  // que ya tenía calculado, y las etiquetas de los ejes son de lo que guarda:
  // sólo las recalcula al converger el tamaño, y eso hay que pedirlo. Como aquí
  // no cambia ninguna escala, sin él no se entera de que hay que reescribirlas y
  // el eje se queda en «duración» para siempre.
  useEffect(() => {
    timeRef.current = time;
    chartRef.current?.redraw(true, true);
  }, [time]);

  // Las cuatro flechas manejan el eje X: ←/→ recorren la grabación y ↑/↓ abren y
  // cierran la ventana de tiempo. Sólo a pantalla completa y en PC: es donde hay
  // teclado y donde la gráfica es lo único en pantalla, así que no le quita las
  // flechas a nadie (dentro de la página se usan para hacer scroll).
  //
  // Mientras la tecla siga abajo se avanza en un bucle de animación, no con el
  // auto-repeat del sistema: ese va a tirones, empieza tarde y su velocidad la
  // decide el teclado de cada uno. Aquí es un movimiento continuo a una velocidad
  // que se elige (ver PAN_* y ZOOM_*).
  //
  // Los dos ejes se llevan por separado a propósito: con ↑ y → pulsadas a la vez
  // se acerca mientras se avanza, que es como se busca un tramo concreto.
  useEffect(() => {
    if (!fullscreen || compact) return;

    let panning = 0; // -1 izquierda, 0 parado, 1 derecha
    let zooming = 0; // -1 acercar, 0 parado, 1 alejar
    let fast = false;
    let frame: number | undefined;
    let previous = 0;

    // Desplaza una fracción de lo que se ve ahora mismo. En fracción y no en
    // segundos a propósito: muy alejado se recorre mucho de golpe y muy cerca se
    // va fino, que es justo lo que se espera de cada uno.
    //
    // Preguntarle a uplot dónde está es leer dos números, así que aquí no hay
    // nada que optimizar: el bucle puede correr a la velocidad de la pantalla.
    const pan = (fraction: number) => {
      const chart = chartRef.current;
      if (chart?.scales.x.min == null || chart.scales.x.max == null) return;
      const { min, max } = chart.scales.x;
      const width = max - min;
      if (width >= signal.lastT - signal.firstT) return; // se ve entera

      // Topa contra los extremos en vez de salirse por ellos.
      const offset = Math.min(
        signal.lastT - max,
        Math.max(signal.firstT - min, width * fraction),
      );
      if (offset === 0) return;
      chart.setScale("x", { min: min + offset, max: max + offset });
    };

    // Abre o cierra la ventana dejando el centro donde está. `amount` es un
    // exponente: la ventana se multiplica por e^amount, así que ir y volver deja
    // exactamente el mismo zoom y acercar cuesta lo mismo que alejar.
    const zoom = (amount: number) => {
      const chart = chartRef.current;
      if (chart?.scales.x.min == null || chart.scales.x.max == null) return;
      const { min, max } = chart.scales.x;
      const span = signal.lastT - signal.firstT;
      const width = max - min;
      const next = Math.min(Math.max(width * Math.exp(amount), MIN_WINDOW), span);
      if (next === width) return; // ya está en un tope

      const centre = (min + max) / 2;
      const win = clampWindow(
        centre - next / 2,
        centre + next / 2,
        signal.firstT,
        signal.lastT,
      );
      chart.setScale("x", { min: win.from, max: win.to });
    };

    const step = (now: number) => {
      const elapsed = Math.min((now - previous) / 1000, MAX_FRAME);
      previous = now;
      const boost = fast ? PAN_FAST : 1;
      // El zoom antes que el desplazamiento: así el paso lateral de este frame ya
      // va en proporción a la ventana nueva y no pega un tirón.
      if (zooming !== 0) zoom(zooming * ZOOM_SPEED * boost * elapsed);
      if (panning !== 0) pan(panning * PAN_SPEED * boost * elapsed);
      frame = requestAnimationFrame(step);
    };

    const stop = () => {
      panning = 0;
      zooming = 0;
      if (frame != null) cancelAnimationFrame(frame);
      frame = undefined;
    };

    // ↑ acerca (ventana más corta) y ↓ aleja, como el zoom de cualquier mapa.
    const readKeys = (key: string) => ({
      pan: key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0,
      zoom: key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0,
    });

    const onKeyDown = (event: KeyboardEvent) => {
      const dir = readKeys(event.key);
      if (dir.pan === 0 && dir.zoom === 0) return;
      event.preventDefault();
      fast = event.shiftKey;
      if (event.repeat) return; // el bucle ya está corriendo; el repeat del SO sobra

      // Un toque corto tiene que notarse sin esperar al primer frame.
      if (dir.pan !== 0) {
        panning = dir.pan;
        pan(dir.pan * PAN_TAP);
      }
      if (dir.zoom !== 0) {
        zooming = dir.zoom;
        zoom(dir.zoom * ZOOM_TAP);
      }
      if (frame == null) {
        previous = performance.now();
        frame = requestAnimationFrame(step);
      }
    };

    // Sólo suelta el eje de la tecla que se levanta: con dos flechas pulsadas,
    // soltar una no tiene por qué dejar la otra clavada. Y el bucle sigue vivo
    // mientras quede algo moviéndose.
    const onKeyUp = (event: KeyboardEvent) => {
      const dir = readKeys(event.key);
      if (dir.pan !== 0 && dir.pan === panning) panning = 0;
      if (dir.zoom !== 0 && dir.zoom === zooming) zooming = 0;
      if (panning === 0 && zooming === 0) stop();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    // Si se cambia de ventana con la tecla pulsada no llega el keyup y la
    // gráfica se quedaría desplazándose sola.
    window.addEventListener("blur", stop);
    return () => {
      stop();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", stop);
    };
  }, [fullscreen, compact, signal]);

  return (
    <div
      ref={wrapRef}
      className="wa-chart"
      style={{
        ...playbackStyles.chart,
        ...(compact && !fullscreen ? playbackStyles.boxCompact : null),
      }}
    >
      <style>{chartCss}</style>
      <div ref={plotRef} style={playbackStyles.plotHost} />
      <div ref={navRef} className="wa-nav" style={playbackStyles.navHost} />
      <div ref={tipRef} style={playbackStyles.tip}>
        <span ref={tipValueRef} style={playbackStyles.tipValue} />
        <span ref={tipTimeRef} style={playbackStyles.tipTime} />
      </div>
    </div>
  );
}

// --- Resumen numérico: los valores del tooltip también se leen sin hover ---

function describe(points: Points | null) {
  if (points == null) return null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (const [, p] of points) {
    if (p === null) continue;
    if (p < min) min = p;
    if (p > max) max = p;
    sum += p;
    count++;
  }
  if (count === 0) return null;
  return {
    min: formatNumber(min, 1),
    max: formatNumber(max, 1),
    mean: formatNumber(sum / count, 2),
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
  // `relative` porque el tooltip se coloca dentro, en coordenadas de aquí.
  chart: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    display: "flex",
    flexDirection: "column" as const,
    position: "relative" as const,
  },
  // En el móvil la tarjeta no se estira, así que la gráfica necesita alto propio.
  boxCompact: { flex: "none", height: "clamp(260px, 48dvh, 460px)" },
  // El alto lo pone el flex, no el contenido: uplot mete su propio lienzo dentro
  // y sin esto se pelearían por decidir quién manda.
  plotHost: { flex: 1, minHeight: 0, width: "100%", overflow: "hidden" },
  navHost: { flex: "none", width: "100%", marginTop: 8 },
  // Sigue al cursor, así que no puede interceptarlo.
  tip: {
    position: "absolute" as const,
    visibility: "hidden" as const,
    pointerEvents: "none" as const,
    zIndex: 5,
    display: "flex",
    flexDirection: "column" as const,
    gap: 2,
    background: PAPER,
    borderWidth: 2,
    borderStyle: "solid" as const,
    borderColor: INK,
    boxShadow: `3px 3px 0 ${INK}`,
    padding: "7px 11px",
    whiteSpace: "nowrap" as const,
  },
  tipValue: { fontFamily: MONO, fontSize: 15, fontWeight: 900, color: INK, lineHeight: 1.1 },
  tipTime: { fontFamily: MONO, fontSize: 11, color: "#666", lineHeight: 1.1 },
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
  readoutWide: { minWidth: 186, whiteSpace: "nowrap" as const },
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
  // Mismo cuerpo que los botones de escala, pero con texto: el activo se rellena
  // de acento en vez de sólo cambiar de borde, que sin ver los dos a la vez no
  // se sabría cuál está puesto.
  modeButton: {
    height: 26,
    display: "flex",
    alignItems: "center",
    background: PAPER,
    color: INK,
    borderWidth: 2,
    borderStyle: "solid" as const,
    borderColor: INK,
    boxShadow: `2px 2px 0 ${INK}`,
    padding: "0 9px",
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 800,
    textTransform: "uppercase" as const,
    letterSpacing: "0.04em",
    lineHeight: 1,
    cursor: "pointer",
    transition: "box-shadow 0.15s ease, border-color 0.15s ease, background-color 0.15s ease",
  },
  modeButtonOn: { background: ACCENT },
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
  sectionEmpty: {
    fontFamily: MONO,
    fontSize: 12,
    color: "#666",
    lineHeight: 1.6,
    margin: 0,
    padding: "10px 0",
  },
  // --- Gráficos de análisis ---
  //
  // Nada de ECharts aquí: son barras, y unas barras son un div con un alto en
  // porcentaje. Montar dos instancias más de la librería para esto sería pagar
  // un precio caro por algo que el navegador ya sabe hacer.
  plots: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
    gap: 28,
  },
  plotsCompact: { gridTemplateColumns: "1fr", gap: 22 },
  plot: { margin: 0, minWidth: 0 },
  // Envuelve: la leyenda vive aquí dentro, y en una columna estrecha tiene que
  // poder caer debajo del título en vez de estrujarlo.
  plotHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap" as const,
    marginBottom: 12,
  },
  plotTitle: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 800,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    color: INK,
  },
  plotNote: {
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 700,
    color: "#888",
  },
  legend: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    flexWrap: "wrap" as const,
  },
  legendItem: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    // El texto va en tinta, nunca en el color de la serie: quien lleva la
    // identidad es la muestra de color de al lado.
    color: "#555",
  },
  legendSwatch: { width: 12, height: 12, border: `1.5px solid ${INK}`, flexShrink: 0 },

  // Tarta: mismo alto que el histograma para que la fila del grid quede pareja.
  // El círculo no lo llena del todo — así las cifras respiran a su lado en vez de
  // quedarse arrinconadas contra el borde de la columna.
  pieRow: { display: "flex", alignItems: "center", gap: 20, height: 132 },
  pie: {
    flexShrink: 0,
    width: 110,
    height: 110,
    borderRadius: "50%",
    border: `2px solid ${INK}`,
  },
  pieKeys: { display: "flex", flexDirection: "column" as const, gap: 16, minWidth: 0 },
  pieKey: { display: "flex", flexDirection: "column" as const, gap: 3, minWidth: 0 },
  pieKeyHead: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    color: "#555",
  },
  // El sangrado deja la cifra a plomo con el texto de arriba, no con la muestra
  // de color (12 del cuadrado + 7 del hueco).
  pieKeyValue: {
    paddingLeft: 19,
    fontFamily: MONO,
    fontSize: 22,
    fontWeight: 900,
    lineHeight: 1,
    color: INK,
  },

  histogram: {
    display: "flex",
    alignItems: "flex-end",
    gap: 2,
    height: 132,
    borderBottom: `2px solid ${INK}`,
  },
  bar: { width: "100%", display: "block" },
  axis: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 7,
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.04em",
    color: "#888",
  },
} satisfies Record<string, React.CSSProperties>;
