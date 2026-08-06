"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { INK, PAPER, ACCENT } from "../theme";
import { isDeviceOnline, isSample } from "../lib/api";
import { useFrontendSocket } from "../lib/useFrontendSocket";
import { useCompact } from "../lib/useCompact";

const MAX_POINTS = 200;

// Vista en vivo de la señal del ESP32. La emisión es un estado derivado del
// lado del server: en cuanto este componente se suscribe (abre el WS),
// server2 manda start_broadcast a la ESP32; al desmontarse, stop_broadcast.
// El navegador nunca manda comandos de emisión — no hay botón start/stop.
export default function LiveWaveform() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesBuffer = useRef<number[]>([]);
  const compact = useCompact();

  const [reportedOnline, setReportedOnline] = useState<boolean | null>(null);
  const [latestSample, setLatestSample] = useState({ pressure: 0, temperature: 0 });
  const [receiving, setReceiving] = useState(false);
  const receivingTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const handleMessage = (data: unknown) => {
    if (isDeviceOnline(data)) {
      setReportedOnline(data.type === "device_online");
      return;
    }
    if (isSample(data)) {
      samplesBuffer.current.push(data.p);
      if (samplesBuffer.current.length > MAX_POINTS) samplesBuffer.current.shift();
      setLatestSample({ pressure: data.p, temperature: data.temp ?? 0 });
      setReceiving(true);
      clearTimeout(receivingTimeout.current);
      receivingTimeout.current = setTimeout(() => setReceiving(false), 1500);
    }
  };

  const { status: wsStatus, fresh } = useFrontendSocket({
    onMessage: handleMessage,
    live: true, // esta es la única vista que pinta la señal
    onOpen: () => {
      samplesBuffer.current = [];
      setReceiving(false);
    },
  });

  // Sin noticias frescas no queda nada que respalde el "conectada" de antes.
  const deviceOnline = fresh ? reportedOnline : false;

  useEffect(() => () => clearTimeout(receivingTimeout.current), []);

  // --- Dibujo: solo el área bajo la curva, sin marcas ---
  useEffect(() => {
    let raf: number;

    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (canvas && ctx) {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();

        if (
          canvas.width !== rect.width * dpr ||
          canvas.height !== rect.height * dpr
        ) {
          canvas.width = rect.width * dpr;
          canvas.height = rect.height * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const width = rect.width;
        const height = rect.height;
        const rightPad = 34; // deja aire para que las marcas nuevas no toquen el borde
        const plotWidth = width - rightPad;
        const mid = height / 2;
        ctx.clearRect(0, 0, width, height);

        // línea base
        ctx.strokeStyle = "rgba(17,17,17,0.25)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(width, mid);
        ctx.stroke();

        const data = samplesBuffer.current.filter((v) => Number.isFinite(v));
        if (data.length > 1) {
          const maxAbs = Math.max(30, ...data.map((v) => Math.abs(v))) + 10;
          const points = data.map((v, i) => ({
            x: (i / (data.length - 1)) * plotWidth,
            y: mid - (v / maxAbs) * (mid - 20),
          }));
          const last = points[points.length - 1];

          const area = new Path2D();
          area.moveTo(points[0].x, mid);
          points.forEach((pt) => area.lineTo(pt.x, pt.y));
          area.lineTo(last.x, mid);
          area.closePath();

          ctx.fillStyle = ACCENT;
          ctx.fill(area);

          ctx.strokeStyle = INK;
          ctx.lineWidth = 3;
          ctx.lineJoin = "round";
          ctx.beginPath();
          points.forEach((pt, i) =>
            i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y),
          );
          ctx.stroke();

          // marca del último dato recibido — la "batuta" que marca el frente de la señal
          ctx.fillStyle = ACCENT;
          ctx.strokeStyle = INK;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(last.x, last.y, 7, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(draw);
    };

    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      <div style={{ ...styles.statusCorner, ...(compact ? mobile.statusCorner : null) }}>
        <ConnectionStatusBadge wsStatus={wsStatus} deviceOnline={deviceOnline} receiving={receiving} />
      </div>

      <section style={{ ...styles.card, ...(compact ? mobile.card : null) }}>
        <div style={{ ...styles.graphHeader, ...(compact ? mobile.graphHeader : null) }}>
          <span style={styles.graphTitle}>Flujo de aire (Presión)</span>
          <div style={{ ...styles.graphHeaderRight, ...(compact ? mobile.graphHeaderRight : null) }}>
            <div style={{ ...styles.metrics, ...(compact ? mobile.metrics : null) }}>
              <Metric
                label="Presión Diferencial"
                value={latestSample.pressure.toFixed(2)}
                unit="Pa"
                compact={compact}
              />
              <Metric
                label="Temperatura Ambiente"
                value={latestSample.temperature.toFixed(1)}
                unit="°C"
                compact={compact}
              />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <BreathIndicator direction="up" label="Inhalation" />
              <BreathIndicator direction="down" label="Exhalation" />
            </div>
          </div>
        </div>
        <canvas ref={canvasRef} style={{ ...styles.canvas, ...(compact ? mobile.canvas : null) }} />
      </section>
    </>
  );
}

// --- Subcomponentes ---

function Metric({
  label,
  value,
  unit,
  compact = false,
}: {
  label: string;
  value: string;
  unit: string;
  compact?: boolean;
}) {
  return (
    <div style={{ ...styles.metricCard, ...(compact ? mobile.metricCard : null) }}>
      <div style={{ ...styles.metricLabel, ...(compact ? mobile.metricLabel : null) }}>{label}</div>
      <div style={{ ...styles.metricValue, ...(compact ? mobile.metricValue : null) }}>
        {value} <span style={styles.metricUnit}>{unit}</span>
      </div>
    </div>
  );
}

function ConnectionStatusBadge({
  wsStatus,
  deviceOnline,
  receiving,
}: {
  wsStatus: "connecting" | "connected" | "disconnected" | "error";
  deviceOnline: boolean | null;
  receiving: boolean;
}) {
  const config = (() => {
    if (wsStatus === "connecting") return { color: "#ca8a04", text: "Conectando" };
    if (wsStatus === "disconnected") return { color: "#dc2626", text: "Desconectado" };
    if (wsStatus === "error") return { color: "#dc2626", text: "Error de red" };
    if (deviceOnline === false) return { color: "#dc2626", text: "ESP32 desconectada" };
    if (receiving) return { color: "#00e0a8", text: "Recibiendo datos" };
    return { color: "#9ca3af", text: "ESP32 conectada" };
  })();

  return (
    <div style={{ ...styles.badge, background: config.color }}>
      <span style={styles.badgeDot} />
      {config.text}
    </div>
  );
}

function BreathIndicator({
  direction,
  label,
}: {
  direction: "up" | "down";
  label: string;
}) {
  return (
    <div style={styles.breathTag}>
      <DirectionArrow direction={direction} />
      {label}
    </div>
  );
}

function DirectionArrow({ direction }: { direction: "up" | "down" }) {
  const rotate = direction === "up" ? 45 : -45;
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      style={{ transform: `rotate(${rotate}deg)` }}
    >
      <line
        x1="12"
        y1="20"
        x2="12"
        y2="4"
        stroke={INK}
        strokeWidth="3"
        strokeLinecap="square"
      />
      <polyline
        points={direction === "up" ? "6,10 12,4 18,10" : "6,14 12,20 18,14"}
        fill="none"
        stroke={INK}
        strokeWidth="3"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

// --- Estilos: brutalista — bordes gruesos, sombra dura, sin curvas ---
const styles: Record<string, CSSProperties> = {
  statusCorner: {
    position: "absolute",
    top: 20,
    right: 32,
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  badge: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "8px 14px",
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: 12,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: INK,
  },
  badgeDot: {
    width: 8,
    height: 8,
    background: INK,
    borderRadius: "50%",
  },
  metrics: { display: "flex", gap: 10 },
  metricCard: {
    flex: "0 0 auto",
    background: "#ffffff",
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "8px 12px",
  },
  metricLabel: {
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontWeight: 700,
    color: "#555",
    whiteSpace: "nowrap",
  },
  metricValue: { fontSize: 20, fontWeight: 900, marginTop: 3, lineHeight: 1 },
  metricUnit: { fontSize: 11, fontWeight: 700, color: "#888" },
  card: {
    background: "#ffffff",
    border: `3px solid ${INK}`,
    boxShadow: `8px 8px 0 ${INK}`,
    padding: 28,
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    flex: 1,
  },
  graphHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
    flexWrap: "wrap",
    gap: 14,
  },
  graphHeaderRight: {
    display: "flex",
    alignItems: "center",
    gap: 20,
    flexWrap: "wrap",
  },
  graphTitle: {
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: 13,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  breathTag: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    border: `2px solid ${INK}`,
    padding: "4px 10px",
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  canvas: {
    width: "100%",
    flex: 1,
    minHeight: 0,
    display: "block",
    background: "#ffffff",
    border: `2px solid ${INK}`,
  },
};

// --- Móvil: la cabecera de la gráfica se apila y el lienzo deja de estirarse
// (la página hace scroll, así que necesita una altura propia). ---
const mobile: Record<string, CSSProperties> = {
  statusCorner: { position: "static", flexWrap: "wrap", gap: 8 },
  card: { padding: 14, flex: "none" },
  graphHeader: { flexDirection: "column", alignItems: "stretch", gap: 10, marginBottom: 12 },
  graphHeaderRight: { flexDirection: "column", alignItems: "stretch", gap: 10 },
  metrics: { gap: 8 },
  metricCard: { flex: "1 1 0", minWidth: 0, padding: "7px 10px" },
  metricLabel: { whiteSpace: "normal" },
  metricValue: { fontSize: 17 },
  canvas: { flex: "none", height: "clamp(220px, 42dvh, 420px)" },
};
