import type { EChartsOption } from "echarts";
import { ACCENT, INK, MONO, PAPER } from "../../theme";

export type Points = [number, number][];

// mm:ss — el eje X son segundos desde la primera muestra
export function axisTime(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Serie única: la línea de tinta es la marca, el acento sólo rellena el área.
// Sin leyenda (el título nombra la serie), rejilla en hairline y crosshair+tooltip.
export function chartOption(points: Points): EChartsOption {
  const lastT = points[points.length - 1][0];

  return {
    animation: false, // series larga: la animación sólo estorba
    backgroundColor: "transparent",
    textStyle: { fontFamily: MONO, color: INK },
    grid: { left: 62, right: 26, top: 18, bottom: 74 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "line", lineStyle: { color: INK, width: 1 } },
      backgroundColor: "#ffffff",
      borderColor: INK,
      borderWidth: 2,
      borderRadius: 0,
      padding: [8, 12],
      textStyle: { fontFamily: MONO, color: INK, fontSize: 12 },
      formatter: (params) => {
        const first = Array.isArray(params) ? params[0] : params;
        const [t, p] = first.value as [number, number];
        // el valor manda, la etiqueta acompaña
        return (
          `<div style="font-weight:900;font-size:15px">${p.toFixed(2)} Pa</div>` +
          `<div style="color:#666;font-size:11px;margin-top:2px">t = ${axisTime(t)}</div>`
        );
      },
    },
    xAxis: {
      type: "value",
      min: 0,
      max: lastT,
      name: "TIEMPO",
      nameLocation: "end",
      nameGap: 10,
      nameTextStyle: { fontSize: 9, color: "#888", fontWeight: "bold" },
      // sin onZero el eje se queda abajo; con la señal centrada en 0 lo dibujaría
      // atravesando la onda por la mitad. El cero lo marca el markLine hairline.
      axisLine: { onZero: false, lineStyle: { color: INK, width: 2 } },
      axisTick: { lineStyle: { color: INK } },
      axisLabel: { formatter: (v: number) => axisTime(v), fontSize: 10, color: "#666" },
      splitLine: { lineStyle: { color: "rgba(17,17,17,0.07)", width: 1 } },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLine: { show: true, lineStyle: { color: INK, width: 2 } },
      axisTick: { lineStyle: { color: INK } },
      axisLabel: { fontSize: 10, color: "#666" },
      splitLine: { lineStyle: { color: "rgba(17,17,17,0.07)", width: 1 } },
    },
    dataZoom: [
      { type: "inside", throttle: 50 },
      {
        type: "slider",
        height: 26,
        bottom: 14,
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
        labelFormatter: (v: number) => axisTime(v),
        textStyle: { fontFamily: MONO, fontSize: 9, color: "#666" },
      },
    ],
    series: [
      {
        type: "line",
        data: points,
        showSymbol: false,
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
