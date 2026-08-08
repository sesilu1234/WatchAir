"use client";
import { useEffect, useState, type CSSProperties } from "react";
import { INK, MONO, PAPER } from "../theme";
import { useCompact } from "../lib/useCompact";

// Borrar no se puede deshacer (se va la fila y el .bin de Storage), así que no
// vale con un clic: hay que escribir la frase entera. En singular o en plural
// según cuántas se lleve por delante, para que se lea lo que de verdad va a
// pasar antes de teclearlo.
const phraseFor = (count: number) => (count === 1 ? "delete recording" : "delete recordings");

export default function DeleteDialog({
  count,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  count: number;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const compact = useCompact();
  const [typed, setTyped] = useState("");
  const phrase = phraseFor(count);
  const ready = typed.trim().toLowerCase() === phrase && !pending;

  // Escape cierra, como cualquier diálogo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div style={styles.overlay} onClick={onCancel}>
      <div
        style={{ ...styles.dialog, ...(compact ? mobile.dialog : null) }}
        onClick={(e) => e.stopPropagation()}
      >
        <p style={styles.title}>
          {count === 1 ? "Borrar la grabación" : `Borrar ${count} grabaciones`}
        </p>
        <p style={styles.detail}>
          Se borran la ficha y el fichero de la señal. Esto no se puede deshacer.
        </p>
        <label style={styles.label}>
          Escribe <span style={styles.phrase}>{phrase}</span> para confirmar
        </label>
        <input
          autoFocus
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ready && onConfirm()}
          placeholder={phrase}
          spellCheck={false}
          autoComplete="off"
          style={styles.input}
        />
        {error != null && <p style={styles.error}>{error}</p>}
        <div style={styles.actions}>
          <button type="button" onClick={onCancel} disabled={pending} style={styles.cancel}>
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!ready}
            style={{
              ...styles.confirm,
              opacity: ready ? 1 : 0.35,
              cursor: ready ? "pointer" : "not-allowed",
            }}
          >
            {pending ? "Borrando…" : "Borrar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Estilos: brutalista — bordes gruesos, sombra dura, sin curvas ---
const styles: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    background: "rgba(17,17,17,0.45)",
  },
  dialog: {
    width: "100%",
    maxWidth: 440,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    background: "#ffffff",
    border: `3px solid ${INK}`,
    boxShadow: `8px 8px 0 ${INK}`,
    padding: "24px 26px",
  },
  title: {
    fontFamily: MONO,
    fontSize: 14,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    margin: 0,
  },
  detail: { fontFamily: MONO, fontSize: 11.5, color: "#666", lineHeight: 1.6, margin: 0 },
  label: {
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "#555",
    marginTop: 4,
  },
  phrase: {
    fontWeight: 900,
    color: INK,
    background: "rgba(220,38,38,0.12)",
    padding: "1px 5px",
    textTransform: "none",
  },
  input: {
    fontFamily: MONO,
    fontSize: 13,
    fontWeight: 700,
    color: INK,
    background: PAPER,
    border: `2px solid ${INK}`,
    padding: "10px 12px",
    width: "100%",
    boxSizing: "border-box",
  },
  error: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    color: "#dc2626",
    margin: 0,
    lineHeight: 1.5,
  },
  actions: { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 },
  cancel: {
    background: PAPER,
    color: INK,
    border: `2px solid ${INK}`,
    boxShadow: `3px 3px 0 ${INK}`,
    padding: "10px 18px",
    fontFamily: MONO,
    fontSize: 11.5,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    cursor: "pointer",
  },
  confirm: {
    background: "#dc2626",
    color: "#fff",
    border: `2px solid ${INK}`,
    boxShadow: `3px 3px 0 ${INK}`,
    padding: "10px 18px",
    fontFamily: MONO,
    fontSize: 11.5,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
};

const mobile: Record<string, CSSProperties> = {
  dialog: { padding: "18px 16px", boxShadow: `5px 5px 0 ${INK}` },
};
