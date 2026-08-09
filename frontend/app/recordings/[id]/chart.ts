import type uPlot from "uplot";
import { formatNumber } from "../../lib/format";
import { ACCENT, INK, PAPER, MONO } from "../../theme";

// y = null marca un hueco (regla de gaps): la línea se corta ahí en vez de unir
// dos muestras separadas por más de 2×LOOP_TIME (ver binaryFormat.ts).
export type Points = [number, number | null][];

// Lo que cambia según dónde se esté pintando la gráfica: pantalla pequeña y/o
// pantalla completa.
export type ChartView = { compact: boolean; fullscreen: boolean };

// --- Los datos, tal y como los quiere uplot ---
//
// Dos columnas alineadas por índice, no una lista de pares. El JSON llega como
// [t, p][], que son 800.000 arrays de dos elementos: 800.000 objetos sueltos en
// el montón. Aquí pasan a ser dos columnas, y ya no se vuelven a tocar.
//
// Y no hay nada más. Ni envolventes, ni submuestreo, ni recortar por ventana:
// uplot agrupa por columna de píxel él solo mientras dibuja, quedándose con el
// mínimo y el máximo de cada una. Es exactamente el trabajo que antes había que
// hacerle a mano, y lo hace dentro de su bucle de dibujado.
//
// El tiempo va en Float64Array porque nunca tiene huecos. La presión no puede:
// un hueco es null y un array tipado no sabe guardar null (uplot lo comprueba
// con === null, así que NaN no serviría).
export type Signal = {
  xs: Float64Array;
  ys: (number | null)[];
  // Los extremos del eje X. La primera muestra no cae exactamente en cero (ver
  // binaryFormat), y es el suelo contra el que topa el desplazamiento.
  firstT: number;
  lastT: number;
};

export function toSignal(points: Points): Signal {
  const n = points.length;
  const xs = new Float64Array(n);
  const ys: (number | null)[] = new Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i][0];
    ys[i] = points[i][1];
  }
  return { xs, ys, firstT: n > 0 ? xs[0] : 0, lastT: n > 0 ? xs[n - 1] : 0 };
}

export const alignedData = (signal: Signal): uPlot.AlignedData => [signal.xs, signal.ys];

// --- Rótulos del eje X ---
//
// Los datos siempre son segundos desde la primera muestra; lo único que cambia
// es cómo se escriben. En "clock" se le suma el inicio de la grabación, así que
// el minuto 20 de una que empezó a las 22:00 se lee 22:20.
export type TimeMode = "elapsed" | "clock";
export type TimeAxis = { mode: TimeMode; startedMs: number };

const pad2 = (n: number) => String(n).padStart(2, "0");

// mm:ss — el eje X son segundos desde la primera muestra
function axisTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

// El rótulo corto, el de las marcas del eje.
export function timeLabel(seconds: number, { mode, startedMs }: TimeAxis): string {
  if (mode === "elapsed") return axisTime(seconds);
  const d = new Date(startedMs + seconds * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// El del tooltip, que sí necesita el segundo: apuntando a un punto concreto,
// "22:20" a secas sería el mismo rótulo durante un minuto entero.
export function tooltipTime(seconds: number, time: TimeAxis): string {
  if (time.mode === "elapsed") return `t = ${axisTime(seconds)}`;
  const d = new Date(time.startedMs + seconds * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// --- Rango del eje Y ---
//
// Fijo y simétrico [-n, n]: la respiración no lo decide. Un eje que se reajusta
// solo hace que la línea de cero suba y baje al hacer zoom y que dos tramos de
// la misma grabación no se puedan comparar a ojo. Con [-n, n] el cero se queda
// clavado en el centro y el usuario elige n con los botones + / −.
export const Y_RANGES = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

// Escalón en el que cae un valor: el primero que lo contiene.
export function rangeIndex(range: number): number {
  const i = Y_RANGES.findIndex((step) => step >= range - 1e-9);
  return i < 0 ? Y_RANGES.length - 1 : i;
}

// Punto de partida: el escalón donde la respiración se ve grande. Se mide por
// el percentil 99 y no por el máximo, porque un pico suelto (un golpe al
// sensor) no tiene por qué dejar la señal aplastada en una franja del centro.
export function defaultRange(points: Points): number {
  const amplitudes = points
    .map(([, p]) => (p === null ? null : Math.abs(p)))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const p99 = amplitudes[Math.floor((amplitudes.length - 1) * 0.99)];
  return nearestRange(p99 * 1.3);
}

// El escalón que más se parece a un valor, en escala logarítmica: para 5,7 gana
// el 5 y no el 10. Recortar un pico raro molesta menos que ver la onda a media
// altura, y para eso están los botones.
function nearestRange(value: number): number {
  if (!(value > 0)) return Y_RANGES[0];
  const distance = (step: number) => Math.abs(Math.log(step / value));
  return Y_RANGES.reduce((best, step) => (distance(step) < distance(best) ? step : best));
}

// Decimales que hacen falta para escribir un escalón: 0,25 → 2; 2,5 → 1; 20 → 0.
function decimalsFor(step: number): number {
  const text = String(step);
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : Math.min(2, text.length - dot - 1);
}

// "±5 Pa" con los decimales justos, para el indicador entre los dos botones.
export function formatRange(range: number): string {
  return `±${formatNumber(range, decimalsFor(range))} Pa`;
}

// --- Tramo visible ---

export type VisibleRange = { from: number; to: number };

// "45 s" / "2,5 min" — cuánto se abarca.
export function formatWindow(seconds: number): string {
  if (seconds < 60) return `${formatNumber(Math.max(0, seconds), 0)} s`;
  return `${formatNumber(seconds / 60, 1)} min`;
}

// "22:14 → 22:19 · 4,7 min" — dónde estás, no sólo cuánto ves. Con una señal que
// se repite casi igual de un tramo a otro, esto es lo único que dice sin lugar a
// dudas si te has movido y hacia dónde.
export function formatVisible(range: VisibleRange, time: TimeAxis): string {
  return (
    `${timeLabel(range.from, time)} → ${timeLabel(range.to, time)}` +
    ` · ${formatWindow(range.to - range.from)}`
  );
}

// Deja un tramo dentro de la grabación sin cambiarle el ancho: topa contra los
// extremos en vez de salirse por ellos.
export function clampWindow(
  from: number,
  to: number,
  firstT: number,
  lastT: number,
): VisibleRange {
  const width = Math.min(to - from, lastT - firstT);
  if (from < firstT) return { from: firstT, to: firstT + width };
  if (to > lastT) return { from: lastT - width, to: lastT };
  return { from, to };
}

// --- Aspecto ---
//
// La rejilla y los rótulos van aquí; el marco de tinta y la línea del cero se
// dibujan a mano en el hook `draw`, porque uplot no tiene una opción para un
// borde de dos píxeles alrededor del área de datos y es justo lo que pide el
// resto de la página.
const GRID = "rgba(17,17,17,0.07)";
const ZERO = "rgba(17,17,17,0.30)";
const LABEL = "#666";

const axisFont = `10px ${MONO}`;

// En el móvil las etiquetas son más cortas y el margen sobra.
const axisSize = (compact: boolean) => ({ x: compact ? 34 : 40, y: compact ? 40 : 52 });

// Marco de tinta + línea del cero, encima de la serie. Las dos cosas en el mismo
// sitio porque las dos son "el papel", no los datos.
function drawFrame(u: uPlot) {
  const { ctx } = u;
  const { left, top, width, height } = u.bbox;
  const ratio = (u.ctx.canvas.width / u.width) || 1;

  ctx.save();
  ctx.translate(0.5, 0.5);

  // El cero sólo si cae dentro de lo que se ve.
  const zero = u.valToPos(0, "y", true);
  if (zero >= top && zero <= top + height) {
    ctx.strokeStyle = ZERO;
    ctx.lineWidth = ratio;
    ctx.beginPath();
    ctx.moveTo(left, zero);
    ctx.lineTo(left + width, zero);
    ctx.stroke();
  }

  ctx.strokeStyle = INK;
  ctx.lineWidth = 2 * ratio;
  ctx.strokeRect(left, top, width, height);
  ctx.restore();
}

// Opciones de la gráfica grande. `read` da los valores que pueden cambiar sin
// rehacer la gráfica (escala Y y modo del eje X): se leen en cada dibujado, así
// que cambiarlos es tocar la referencia y pedir un redraw.
export function mainOpts(opts: {
  width: number;
  height: number;
  compact: boolean;
  read: () => { range: number; time: TimeAxis };
  onScale: () => void;
  onCursor: () => void;
}): uPlot.Options {
  const { width, height, compact, read, onScale, onCursor } = opts;
  const size = axisSize(compact);

  return {
    width,
    height,
    // El marco lo dibujamos nosotros justo en el borde del área de datos, así
    // que hace falta un pelo de aire alrededor para que no lo recorte el lienzo.
    padding: [10, 12, 0, 0],
    legend: { show: false },
    cursor: {
      // Arrastrar de lado hace zoom sobre lo arrastrado; es la única forma de
      // hacer zoom fino, y viene de serie.
      drag: { x: true, y: false, setScale: true },
      points: { show: false },
      y: false,
    },
    scales: {
      x: { time: false },
      // Fija y simétrica: la manda el usuario con los botones, no los datos.
      y: { auto: false, range: () => [-read().range, read().range] },
    },
    axes: [
      {
        stroke: LABEL,
        font: axisFont,
        size: size.x,
        gap: 6,
        ticks: { show: true, stroke: INK, width: 1, size: 5 },
        grid: { show: true, stroke: GRID, width: 1 },
        border: { show: false },
        values: (_u, splits) => splits.map((v) => timeLabel(v, read().time)),
      },
      {
        stroke: LABEL,
        font: axisFont,
        size: size.y,
        gap: 6,
        ticks: { show: true, stroke: INK, width: 1, size: 5 },
        grid: { show: true, stroke: GRID, width: 1 },
        border: { show: false },
        // Cinco divisiones fijas: -n, -n/2, 0, n/2, n. Caiga donde caiga la
        // señal son siempre las mismas, así que la rejilla tampoco baila.
        splits: () => {
          const r = read().range;
          return [-r, -r / 2, 0, r / 2, r];
        },
        values: (_u, splits) =>
          splits.map((v) => formatNumber(v, decimalsFor(read().range / 2))),
      },
    ],
    series: [
      {},
      {
        stroke: INK,
        width: 2,
        fill: "rgba(0,224,168,0.35)",
        // El área se rellena contra el cero y no contra el suelo: inspirar y
        // espirar quedan a lados opuestos, que es lo que se quiere leer.
        fillTo: () => 0,
        points: { show: false },
        // Un hueco se ve como un hueco, no como una recta larga entre dos
        // muestras lejanas.
        spanGaps: false,
      },
    ],
    hooks: {
      draw: [drawFrame],
      setScale: [onScale],
      setCursor: [onCursor],
    },
  };
}

// --- La tira de abajo ---
//
// La grabación entera de un vistazo, con el tramo que se está viendo marcado
// encima. En una grabación de nueve horas es lo único que dice por dónde vas, y
// se puede pinchar para saltar. Es otra gráfica de uplot, pero sin ejes, sin
// cursor y sin zoom: se dibuja una vez y ya.
export function navOpts(opts: {
  width: number;
  height: number;
  read: () => { range: number; window: VisibleRange };
}): uPlot.Options {
  const { width, height, read } = opts;

  return {
    width,
    height,
    padding: [2, 0, 2, 0],
    legend: { show: false },
    cursor: { show: false, drag: { x: false, y: false } },
    scales: { x: { time: false }, y: { auto: false, range: () => [-read().range, read().range] } },
    axes: [{ show: false }, { show: false }],
    series: [
      {},
      { stroke: "rgba(17,17,17,0.55)", width: 1, fill: "rgba(17,17,17,0.08)", points: { show: false } },
    ],
    hooks: {
      draw: [
        (u: uPlot) => {
          const { ctx } = u;
          const { left, top, width: w, height: h } = u.bbox;
          const ratio = (u.ctx.canvas.width / u.width) || 1;
          const { from, to } = read().window;
          const x0 = Math.max(left, u.valToPos(from, "x", true));
          const x1 = Math.min(left + w, u.valToPos(to, "x", true));

          ctx.save();
          // Fuera del tramo se apaga; dentro se tiñe de acento. Así el trozo que
          // estás mirando se lee de un golpe de vista sobre la silueta.
          ctx.fillStyle = "rgba(242,241,236,0.72)";
          ctx.fillRect(left, top, x0 - left, h);
          ctx.fillRect(x1, top, left + w - x1, h);
          ctx.fillStyle = "rgba(0,224,168,0.22)";
          ctx.fillRect(x0, top, Math.max(x1 - x0, ratio), h);

          ctx.translate(0.5, 0.5);
          ctx.strokeStyle = INK;
          ctx.lineWidth = 2 * ratio;
          ctx.strokeRect(x0, top, Math.max(x1 - x0, ratio), h);
          ctx.strokeRect(left, top, w, h);
          ctx.restore();
        },
      ],
    },
  };
}

// Estilos de los trozos que pinta uplot por su cuenta (la cruz del cursor y el
// rectángulo de la selección al arrastrar). Van en CSS porque son elementos del
// DOM, no del lienzo, y uplot los trae con su propio color por defecto.
export const chartCss = `
.wa-chart .u-cursor-x { border-right: 1px dashed ${INK}; }
.wa-chart .u-select { background: rgba(0,224,168,0.25); border: 2px solid ${INK}; }
.wa-chart .u-cursor-pt { display: none; }
.wa-nav canvas { cursor: pointer; }
`;

export const TIP_BG = PAPER;
export const TIP_ACCENT = ACCENT;
