"use client";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ECharts } from "echarts";
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
  chartOption,
  chartTimePatch,
  chartViewPatch,
  chartYPatch,
  defaultRange,
  formatRange,
  formatVisible,
  FULL_ZOOM,
  rangeIndex,
  visibleRange,
  Y_RANGES,
  zoomFromEvent,
  type ChartView,
  type Points,
  type TimeAxis,
  type TimeMode,
  type VisibleRange,
  type ZoomRange,
} from "./chartOption";
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
          points={points}
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
  if (!compact) return "Rueda o arrastra para hacer zoom";
  return fullscreen ? "Pellizca y arrastra la gráfica" : "Pellizca para hacer zoom";
}

function ChartArea({
  points,
  error,
  view,
  range,
  time,
  onWindow,
}: {
  points: Points | null;
  error: string | null;
  view: ChartView;
  range: number | null;
  time: TimeAxis;
  onWindow: (range: VisibleRange) => void;
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

// --- Gráfica ECharts ---

function PressureChart({
  points,
  range,
  time,
  onWindow,
  compact,
  fullscreen,
}: {
  points: Points;
  range: number;
  time: TimeAxis;
  onWindow: (range: VisibleRange) => void;
  compact: boolean;
  fullscreen: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  // echarts se carga de forma asíncrona: cuando termine puede que la vista, la
  // escala o los rótulos ya hayan cambiado, así que los lee de aquí y no del
  // closure.
  const viewRef = useRef<ChartView>({ compact, fullscreen });
  const rangeRef = useRef(range);
  const timeRef = useRef(time);
  // Dónde está el zoom ahora mismo, en el porcentaje del dataZoom. Lo llevamos
  // nosotros porque la gráfica sólo sabe decirlo clonando la serie entera (ver
  // zoomFromEvent): lo escriben el evento de dataZoom y el propio pan().
  const zoomRef = useRef<ZoomRange>(FULL_ZOOM);

  useEffect(() => {
    const container = containerRef.current;
    if (container == null) return;

    let chart: ECharts | undefined;
    let observer: ResizeObserver | undefined;
    let disposed = false;
    let readout: number | undefined;
    const span = points[points.length - 1][0] - points[0][0];

    // echarts sólo en el navegador: import dinámico para no cargarlo en el SSR
    import("echarts").then((echarts) => {
      if (disposed) return;
      const instance = echarts.init(container, undefined, { renderer: "canvas" });
      chart = instance;
      chartRef.current = instance;
      // La gráfica nace enseñándolo todo, así que el apunte del zoom también.
      zoomRef.current = FULL_ZOOM;
      instance.setOption(chartOption(points, viewRef.current, rangeRef.current, timeRef.current));
      // Al arrancar se ve la grabación entera; después, lo que deje el zoom.
      const report = () => onWindow(visibleRange(zoomRef.current, span));
      instance.on("dataZoom", (params: unknown) => {
        const next = zoomFromEvent(params);
        if (next != null) zoomRef.current = next;
        // Un solo aviso pendiente cada vez: mientras el zoom se mueva sale uno
        // cada READOUT_MS, y al parar cae el último con el sitio definitivo, así
        // que el rótulo nunca se queda un paso atrás.
        if (readout == null) {
          readout = window.setTimeout(() => {
            readout = undefined;
            report();
          }, READOUT_MS);
        }
      });
      report();
      // También cubre el cambio de tamaño al entrar y salir de pantalla completa.
      observer = new ResizeObserver(() => instance.resize());
      observer.observe(container);
    });

    return () => {
      disposed = true;
      chartRef.current = null;
      if (readout != null) clearTimeout(readout);
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

  // Ídem con duración/hora real: mismos datos, sólo se reescriben los rótulos.
  useEffect(() => {
    timeRef.current = time;
    chartRef.current?.setOption(chartTimePatch(time));
  }, [time]);

  // Flechas ←/→ para recorrer el eje X. Sólo a pantalla completa y en PC: es
  // donde hay teclado y donde la gráfica es lo único en pantalla, así que no le
  // quita las flechas a nadie (dentro de la página se usan para hacer scroll).
  //
  // Mientras la tecla siga abajo se avanza en un bucle de animación, no con el
  // auto-repeat del sistema: ese va a tirones, empieza tarde y su velocidad la
  // decide el teclado de cada uno. Aquí es un desplazamiento continuo a una
  // velocidad que se elige (ver PAN_*).
  useEffect(() => {
    if (!fullscreen || compact) return;

    let direction = 0; // -1 izquierda, 0 parado, 1 derecha
    let fast = false;
    let frame: number | undefined;
    let previous = 0;

    // Desplaza una fracción de lo que se ve ahora mismo. En fracción y no en
    // segundos a propósito: muy alejado se recorre mucho de golpe y muy cerca se
    // va fino, que es justo lo que se espera de cada uno.
    const pan = (fraction: number) => {
      const chart = chartRef.current;
      if (chart == null) return;
      const { start, end } = zoomRef.current;
      const width = end - start;
      if (width >= 100) return; // se ve entera: no hay nada fuera adonde ir

      // Topa contra los extremos en vez de salirse por ellos.
      const offset = Math.min(100 - end, Math.max(-start, width * fraction));
      if (offset === 0) return;
      // Antes de despachar: el apunte lo lleva quien mueve la gráfica, y así el
      // frame siguiente parte de aquí sin tener que preguntarle nada a nadie.
      zoomRef.current = { start: start + offset, end: end + offset };
      chart.dispatchAction({ type: "dataZoom", start: start + offset, end: end + offset });
    };

    const step = (now: number) => {
      const elapsed = Math.min((now - previous) / 1000, MAX_FRAME);
      previous = now;
      if (direction !== 0) pan(direction * PAN_SPEED * (fast ? PAN_FAST : 1) * elapsed);
      frame = requestAnimationFrame(step);
    };

    const stop = () => {
      direction = 0;
      if (frame != null) cancelAnimationFrame(frame);
      frame = undefined;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const dir = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (dir === 0) return;
      event.preventDefault();
      fast = event.shiftKey;
      if (event.repeat) return; // el bucle ya está corriendo; el repeat del SO sobra

      direction = dir;
      pan(dir * PAN_TAP); // que un toque corto se note, sin esperar al primer frame
      if (frame == null) {
        previous = performance.now();
        frame = requestAnimationFrame(step);
      }
    };

    // Sólo para si lo que se suelta es la tecla que estaba moviendo: con las dos
    // flechas pulsadas, soltar la contraria no tiene por qué dejarlo clavado.
    const onKeyUp = (event: KeyboardEvent) => {
      const dir = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (dir !== 0 && dir === direction) stop();
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
  }, [fullscreen, compact]);

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
