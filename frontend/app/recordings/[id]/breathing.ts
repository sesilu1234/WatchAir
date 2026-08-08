import type { Points } from "./chartOption";

// Métricas de la respiración sacadas de la propia señal: en el fichero no hay
// nada de esto, todo sale de contar cuándo la presión cruza el cero. Se calcula
// en el navegador sobre las muestras que ya están cargadas para la gráfica.

// Un ciclo: cuánto duró y hasta dónde llegó en cada lado del cero. No sale de
// este módulo: es el paso intermedio del que salen las tres cifras de abajo.
type Cycle = { duration: number; up: number; down: number };

// Las tres cifras que se enseñan, y ninguna más: cómo de rápido respira, cómo
// de fuerte y cómo de parejo. El reparto entre inspirar y espirar va aparte,
// en phaseSplit, porque se mide de otra forma.
export type Breathing = {
  rpm: number; // frecuencia respiratoria
  amplitude: number; // pico a pico medio, en Pa
  cycleSpread: number; // desviación típica de la duración de ciclo
};

// Percentil de |presión|. Se usa en todo el módulo en lugar del máximo: un
// golpe al sensor no debe subir el listón ni estirar ninguna escala.
function percentile(points: Points, q: number): number {
  const amplitudes = points
    .map(([, p]) => (p === null ? null : Math.abs(p)))
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  if (amplitudes.length === 0) return 0;
  return amplitudes[Math.floor((amplitudes.length - 1) * q)];
}

type Phase = { sign: 1 | -1; start: number; end: number; peak: number };

// Trocea la señal en fases alternas. Entre −umbral y +umbral no se cambia de
// fase: la de antes sigue viva hasta que la señal cruza de verdad al otro lado.
// Sin esa banda muerta, el ruido alrededor del cero contaría decenas de cruces
// por respiración.
//
// Los huecos (y = null) no cortan la fase, sólo no aportan; una grabación con
// huecos largos puede juntar dos fases en una y salir con menos ciclos.
function phases(points: Points, thr: number): Phase[] {
  const out: Phase[] = [];

  for (const [t, p] of points) {
    if (p === null) continue;
    const sign = p >= thr ? 1 : p <= -thr ? -1 : 0;
    const current = out.length > 0 ? out[out.length - 1] : null;

    if (sign !== 0 && current?.sign !== sign) {
      if (current) current.end = t;
      out.push({ sign, start: t, end: t, peak: Math.abs(p) });
    } else if (current) {
      current.end = t;
      current.peak = Math.max(current.peak, Math.abs(p));
    }
  }
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function analyseBreathing(points: Points | null): Breathing | null {
  if (points == null || points.length < 2) return null;
  // 15 % del percentil 95: el umbral se adapta a lo fuerte que respire cada uno
  // en vez de ser un número mágico igual para todas las grabaciones.
  const thr = percentile(points, 0.95) * 0.15;
  if (!(thr > 0)) return null;

  const all = phases(points, thr);
  const up = all.filter((p) => p.sign === 1);
  const down = all.filter((p) => p.sign === -1);
  if (up.length === 0 || down.length === 0) return null;

  // Un ciclo va del arranque de una fase al arranque de la siguiente del mismo
  // signo. El último se descarta: acabaría donde acaba la grabación, no donde
  // acaba el ciclo, y falsearía la media hacia abajo.
  const cycles: Cycle[] = [];
  for (let i = 0; i + 2 < all.length; i++) {
    if (all[i].sign !== 1) continue;
    cycles.push({
      duration: all[i + 2].start - all[i].start,
      up: all[i].peak,
      down: all[i + 1].peak,
    });
  }
  if (cycles.length === 0) return null;

  const durations = cycles.map((c) => c.duration);
  const meanCycle = mean(durations);

  return {
    rpm: meanCycle > 0 ? 60 / meanCycle : 0,
    amplitude: mean(up.map((p) => p.peak)) + mean(down.map((p) => p.peak)),
    cycleSpread: Math.sqrt(mean(durations.map((d) => (d - meanCycle) ** 2))),
  };
}

// --- Reparto del tiempo entre los dos lados del cero ---

export type PhaseSplit = { positive: number; negative: number }; // fracciones, suman 1

// Muestra a muestra, y sin banda muerta a propósito: aquí la pregunta es de qué
// lado del cero está la señal, no cuándo cambia de fase de verdad (eso es lo que
// hace `phases`, y su umbral dejaría un trozo del tiempo sin repartir).
//
// Contar muestras es medir tiempo porque el muestreo es uniforme (25 Hz); los
// huecos no cuentan, que es justo lo que se quiere: no se reparte el tiempo del
// que no hay señal.
export function phaseSplit(points: Points): PhaseSplit | null {
  let positive = 0;
  let negative = 0;

  for (const [, p] of points) {
    if (p === null || p === 0) continue;
    if (p > 0) positive++;
    else negative++;
  }

  const total = positive + negative;
  return total > 0 ? { positive: positive / total, negative: negative / total } : null;
}

// --- Reparto de la presión ---

export type Histogram = { counts: number[]; limit: number; peak: number };

// Bins simétricos alrededor del cero, y en número par a propósito: así el cero
// cae justo en un borde y ningún bin mezcla los dos signos, que es lo que
// permite colorear cada mitad por su lado.
export function pressureHistogram(points: Points, bins = 28): Histogram | null {
  const limit = percentile(points, 0.99);
  if (!(limit > 0)) return null;

  const counts = new Array<number>(bins).fill(0);
  const width = (2 * limit) / bins;
  let total = 0;

  for (const [, p] of points) {
    if (p === null) continue;
    // Los extremos se recogen en el primer y el último bin: un pico suelto no
    // debe estirar la escala y dejar el resto del histograma aplastado.
    const i = Math.min(bins - 1, Math.max(0, Math.floor((p + limit) / width)));
    counts[i]++;
    total++;
  }

  return total > 0 ? { counts, limit, peak: Math.max(...counts) } : null;
}
