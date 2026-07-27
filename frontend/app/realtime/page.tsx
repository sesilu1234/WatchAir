"use client";
import type { CSSProperties } from "react";
import LiveWaveform from "../components/LiveWaveform";
import { PAPER, INK } from "../theme";

export default function RespirationMonitor() {
  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.title}>Registrador Respiratorio</h1>
        <p style={styles.subtitle}>Señal en tiempo real</p>
      </header>

      <LiveWaveform />
    </main>
  );
}

// --- Estilos: brutalista — bordes gruesos, sombra dura, sin curvas ---
const styles: Record<string, CSSProperties> = {
  main: {
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    height: "100vh",
    width: "100%",
    boxSizing: "border-box",
    padding: "28px 48px 40px",
    background: PAPER,
    color: INK,
    display: "grid",
    gridTemplateRows: "auto 1fr",
    gap: 18,
    overflow: "hidden",
    position: "relative",
  },
  header: {
    borderBottom: `2px solid ${INK}`,
    paddingBottom: 14,
    paddingRight: 140,
  },
  title: {
    fontSize: 26,
    fontWeight: 900,
    letterSpacing: "-0.02em",
    textTransform: "uppercase",
    margin: 0,
  },
  subtitle: {
    fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#555",
    margin: "4px 0 0 0",
  },
};
