import type { ECharts, EChartsOption } from "echarts";
import { formatNumber } from "../../lib/format";
import { ACCENT, INK, MONO, PAPER } from "../../theme";

// y = null marca un hueco (regla de gaps): ECharts corta la línea ahí en vez
// de unir dos muestras separadas por más de 2×LOOP_TIME (ver binaryFormat.ts).
export type Points = [number, number | null][];

// Lo que cambia según dónde se esté pintando la gráfica: pantalla pequeña y/o
// pantalla completa.
export type ChartView = { compact: boolean; fullscreen: boolean };

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

// El rótulo corto, el de las marcas del eje y del slider.
export function timeLabel(seconds: number, { mode, startedMs }: TimeAxis): string {
  if (mode === "elapsed") return axisTime(seconds);
  const d = new Date(startedMs + seconds * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// El del tooltip, que sí necesita el segundo: apuntando a un punto concreto,
// "22:20" a secas sería el mismo rótulo durante un minuto entero.
function tooltipTime(seconds: number, time: TimeAxis): string {
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

// Qué tramo se está viendo ahora mismo, en segundos desde el principio. El
// dataZoom trabaja en porcentaje sobre la grabación entera.
export type VisibleRange = { from: number; to: number };

export function visibleRange(chart: ECharts, span: number): VisibleRange {
  const option = chart.getOption() as { dataZoom?: { start?: number; end?: number }[] };
  const zoom = option.dataZoom?.[0];
  return {
    from: ((zoom?.start ?? 0) / 100) * span,
    to: ((zoom?.end ?? 100) / 100) * span,
  };
}

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

// Cuatro divisiones: -n, -n/2, 0, n/2, n. Siempre las mismas, caiga donde caiga
// la señal, así que la rejilla tampoco baila.
const yAxisFor = (range: number) => {
  const interval = range / 2;
  return {
    min: -range,
    max: range,
    interval,
    axisLabel: {
      fontSize: 10,
      color: "#666",
      formatter: (v: number) => formatNumber(v, decimalsFor(interval)),
    },
  };
};

// En el móvil las etiquetas de los ejes son más cortas y el margen sobra.
const gridFor = ({ compact }: ChartView) =>
  compact
    ? { left: 46, right: 20, top: 14, bottom: 58 }
    : { left: 62, right: 26, top: 18, bottom: 74 };

const sliderFor = ({ compact }: ChartView) =>
  compact ? { height: 22, bottom: 10 } : { height: 26, bottom: 14 };

// Arrastrar con el dedo desplaza la gráfica, y entonces el gesto ya no sirve
// para hacer scroll en la página. Dentro de la tarjeta gana la página; en
// pantalla completa no hay página que desplazar, así que gana la gráfica.
// (El pellizco para hacer zoom funciona en los dos casos.)
//
// Hacen falta las dos opciones: moveOnMouseMove decide si la gráfica se mueve,
// pero es preventDefaultMouseMove quien deja pasar (o no) el gesto al navegador.
const dragFor = (view: ChartView) => {
  const enabled = !view.compact || view.fullscreen;
  return { moveOnMouseMove: enabled, preventDefaultMouseMove: enabled };
};

// Ajustes que dependen del tamaño de pantalla, en formato de setOption parcial:
// al girar el móvil o entrar en pantalla completa se aplican sin volver a pintar
// la serie entera ni perder el zoom que tuviera el usuario.
export function chartViewPatch(view: ChartView): EChartsOption {
  return {
    grid: gridFor(view),
    dataZoom: [
      { type: "inside", ...dragFor(view) },
      { type: "slider", ...sliderFor(view) },
    ],
  };
}

// Cambiar el rango del eje Y no toca ni la serie ni el zoom del eje X.
export function chartYPatch(range: number): EChartsOption {
  return { yAxis: yAxisFor(range) };
}

// Cambiar de duración a hora real es sólo reescribir rótulos: mismos datos,
// mismo zoom, misma serie. Por eso va como parche y no repintando la gráfica.
export function chartTimePatch(time: TimeAxis): EChartsOption {
  return {
    xAxis: xAxisLabelsFor(time),
    tooltip: { formatter: tooltipFormatter(time) },
    dataZoom: [{ type: "inside" }, { type: "slider", labelFormatter: (v: number) => timeLabel(v, time) }],
  };
}

const xAxisLabelsFor = (time: TimeAxis) => ({
  name: time.mode === "clock" ? "HORA" : "TIEMPO",
  axisLabel: { formatter: (v: number) => timeLabel(v, time), fontSize: 10, color: "#666" },
});

const tooltipFormatter = (time: TimeAxis) => (params: unknown) => {
  const first = Array.isArray(params) ? params[0] : params;
  const [t, p] = (first as { value: [number, number | null] }).value;
  // el valor manda, la etiqueta acompaña; en un hueco no hay presión que mostrar
  const value = p === null ? "—" : `${p.toFixed(2)} Pa`;
  return (
    `<div style="font-weight:900;font-size:15px">${value}</div>` +
    `<div style="color:#666;font-size:11px;margin-top:2px">${tooltipTime(t, time)}</div>`
  );
};

// Serie única: la línea de tinta es la marca, el acento sólo rellena el área.
// Sin leyenda (el título nombra la serie), rejilla en hairline y crosshair+tooltip.
export function chartOption(
  points: Points,
  view: ChartView,
  range: number,
  time: TimeAxis,
): EChartsOption {
  const lastT = points[points.length - 1][0];

  return {
    animation: false, // series larga: la animación sólo estorba
    backgroundColor: "transparent",
    textStyle: { fontFamily: MONO, color: INK },
    grid: gridFor(view),
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: INK, width: 1 } },
      confine: true, // en el móvil, sin esto se sale del lienzo
      backgroundColor: "#ffffff",
      borderColor: INK,
      borderWidth: 2,
      borderRadius: 0,
      padding: [8, 12],
      textStyle: { fontFamily: MONO, color: INK, fontSize: 12 },
      formatter: tooltipFormatter(time),
    },
    xAxis: {
      type: "value",
      min: 0,
      max: lastT,
      ...xAxisLabelsFor(time),
      nameLocation: "end",
      nameGap: 10,
      nameTextStyle: { fontSize: 9, color: "#888", fontWeight: "bold" },
      // sin onZero el eje se queda abajo; con la señal centrada en 0 lo dibujaría
      // atravesando la onda por la mitad. El cero lo marca el markLine hairline.
      axisLine: { onZero: false, lineStyle: { color: INK, width: 2 } },
      axisTick: { lineStyle: { color: INK } },
      splitLine: { lineStyle: { color: "rgba(17,17,17,0.07)", width: 1 } },
      // Bandas alternas entre marca y marca. Es lo que hace que desplazarse se
      // note: la respiración se repite casi igual de un ciclo a otro, pero las
      // bandas no se alinean con ella, así que verlas pasar dice que te mueves y
      // cuánto. Las calcula ECharts con las mismas divisiones que las etiquetas
      // del eje, así que se adaptan solas al zoom sin generar nada.
      splitArea: {
        show: true,
        areaStyle: { color: ["rgba(17,17,17,0.045)", "transparent"] },
      },
    },
    yAxis: {
      type: "value",
      ...yAxisFor(range),
      axisLine: { show: true, lineStyle: { color: INK, width: 2 } },
      axisTick: { lineStyle: { color: INK } },
      splitLine: { lineStyle: { color: "rgba(17,17,17,0.07)", width: 1 } },
    },
    dataZoom: [
      { type: "inside", throttle: 50, ...dragFor(view) },
      {
        type: "slider",
        ...sliderFor(view),
        borderColor: INK,
        backgroundColor: PAPER,
        fillerColor: "rgba(0,224,168,0.22)",
        handleStyle: { color: ACCENT, borderColor: INK, borderWidth: 2 },
        moveHandleStyle: { color: INK },
        dataBackground: {
          lineStyle: { color: "rgba(17,17,17,0.45)", width: 1 },
          areaStyle: { color: "rgba(17,17,17,0.08)" },
        },
        selectedDataBackground: {
          lineStyle: { color: INK, width: 1 },
          areaStyle: { color: "rgba(0,224,168,0.35)" },
        },
        labelFormatter: (v: number) => timeLabel(v, time),
        textStyle: { fontFamily: MONO, fontSize: 9, color: "#666" },
      },
    ],
    series: [
      {
        type: "line",
        data: points,
        showSymbol: false,
        // Explícito aunque sea el defecto: es lo que hace que un hueco se vea
        // como un hueco en vez de como una recta larga entre dos muestras.
        connectNulls: false,
        sampling: "lttb", // decenas de miles de puntos sin matar el navegador
        lineStyle: { color: INK, width: 2 },
        // el área se rellena contra 0: inspirar y espirar quedan a lados opuestos
        areaStyle: { color: "rgba(0,224,168,0.35)", origin: 0 },
        emphasis: { disabled: true },
        markLine: {
          silent: true,
          symbol: "none",
          animation: false,
          data: [{ yAxis: 0 }],
          lineStyle: { color: "rgba(17,17,17,0.3)", width: 1, type: "solid" },
          label: { show: false },
        },
      },
    ],
  };
}
