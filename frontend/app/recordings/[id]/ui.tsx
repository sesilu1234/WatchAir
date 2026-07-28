// Piezas compartidas por la vista en vivo y la de reproducción de una grabación.
import Link from "next/link";
import type { CSSProperties } from "react";
import { ACCENT, INK, MONO, PAPER } from "../../theme";

export function BackLink() {
  return (
    <Link href="/recordings" style={styles.topBack}>
      <ChevronLeft />
      Grabaciones
    </Link>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <div style={styles.statLabel}>{label}</div>
      <div style={styles.statValue}>{value}</div>
    </div>
  );
}

export function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M15 5l-7 7 7 7" stroke={INK} strokeWidth="2.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

// Pantalla completa para los estados sin datos: 404, backend caído, cargando…
export function Notice({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: { href: string; label: string };
}) {
  return (
    <main style={styles.main}>
      <BackLink />
      <div style={styles.notice}>
        <p style={styles.noticeTitle}>{title}</p>
        {detail && <p style={styles.noticeDetail}>{detail}</p>}
        {action && (
          <Link href={action.href} style={styles.noticeButton}>
            {action.label}
          </Link>
        )}
      </div>
    </main>
  );
}

// --- Estilos: brutalista — bordes gruesos, sombra dura, sin curvas ---
export const styles: Record<string, CSSProperties> = {
  main: {
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    height: "100vh",
    width: "100%",
    boxSizing: "border-box",
    padding: "28px 48px 40px",
    background: PAPER,
    color: INK,
    display: "flex",
    flexDirection: "column",
    gap: 14,
    overflow: "hidden",
    position: "relative",
  },
  topBack: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: INK,
    textDecoration: "none",
    flexShrink: 0,
  },
  header: {
    borderBottom: `2px solid ${INK}`,
    paddingBottom: 14,
    flexShrink: 0,
  },
  title: {
    fontSize: 26,
    fontWeight: 900,
    letterSpacing: "-0.02em",
    textTransform: "uppercase",
    margin: 0,
  },
  subtitle: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#555",
    margin: "4px 0 0 0",
  },

  // barra de métricas
  bar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 14,
    flexWrap: "wrap",
    background: "#ffffff",
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "14px 18px",
  },
  stat: {
    flex: "0 0 auto",
    paddingRight: 14,
    borderRight: "1px solid rgba(17,17,17,0.16)",
  },
  statLabel: {
    fontFamily: MONO,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontWeight: 700,
    color: "#555",
  },
  statValue: { fontSize: 20, fontWeight: 900, marginTop: 4, fontFamily: MONO },

  // tarjeta que contiene la gráfica
  card: {
    flex: 1,
    minHeight: 0,
    background: "#ffffff",
    border: `3px solid ${INK}`,
    boxShadow: `8px 8px 0 ${INK}`,
    padding: 24,
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
    flexShrink: 0,
  },
  cardTitle: {
    fontFamily: MONO,
    fontSize: 13,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },

  // botones
  button: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: PAPER,
    color: INK,
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "10px 18px",
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    textDecoration: "none",
    cursor: "pointer",
  },
  buttonStop: { marginLeft: "auto", background: "#dc2626", color: "#fff", fontSize: 13, fontWeight: 900 },
  buttonAccent: { background: ACCENT },

  // avisos a pantalla completa
  notice: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    textAlign: "center",
  },
  noticeTitle: {
    fontFamily: MONO,
    fontSize: 14,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    margin: 0,
  },
  noticeDetail: {
    fontFamily: MONO,
    fontSize: 12,
    color: "#666",
    lineHeight: 1.6,
    maxWidth: 460,
    margin: 0,
  },
  noticeButton: {
    background: ACCENT,
    color: INK,
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "10px 18px",
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    textDecoration: "none",
  },
};
