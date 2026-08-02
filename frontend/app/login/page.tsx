"use client";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import { Suspense, type CSSProperties } from "react";
import { ACCENT, INK, MONO, PAPER } from "../theme";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginCard />
    </Suspense>
  );
}

function LoginCard() {
  const params = useSearchParams();
  const denied = params.get("error") === "AccessDenied";

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <div style={styles.logoBox}>
          <span style={styles.logoMark}>W</span>
        </div>
        <h1 style={styles.title}>WatchAir</h1>
        <p style={styles.subtitle}>Monitorización respiratoria en tiempo real</p>

        {denied && (
          <p style={styles.error}>
            Esta cuenta de Google no tiene un dispositivo asociado. Habla con quien gestiona WatchAir
            para que te dé de alta.
          </p>
        )}

        <button style={styles.button} onClick={() => signIn("google", { callbackUrl: "/realtime" })}>
          <GoogleIcon />
          Entrar con Google
        </button>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M21.6 12.23c0-.75-.07-1.47-.19-2.16H12v4.09h5.4a4.62 4.62 0 0 1-2 3.03v2.5h3.24c1.9-1.75 2.96-4.32 2.96-7.46Z"
      />
      <path
        fill="currentColor"
        d="M12 22c2.7 0 4.96-.89 6.62-2.42l-3.24-2.5c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.75-5.59-4.11H3.06v2.58A10 10 0 0 0 12 22Z"
      />
      <path fill="currentColor" d="M6.41 13.93A5.99 5.99 0 0 1 6.09 12c0-.67.12-1.32.32-1.93V7.49H3.06A10 10 0 0 0 2 12c0 1.61.39 3.14 1.06 4.51l3.35-2.58Z" />
      <path
        fill="currentColor"
        d="M12 6.02c1.47 0 2.79.5 3.82 1.49l2.87-2.87C16.95 2.99 14.7 2 12 2 8.19 2 4.91 4.19 3.06 7.49l3.35 2.58C7.2 7.77 9.4 6.02 12 6.02Z"
      />
    </svg>
  );
}

const styles: Record<string, CSSProperties> = {
  main: {
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    height: "100vh",
    width: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: PAPER,
    color: INK,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 14,
    background: "#ffffff",
    border: `3px solid ${INK}`,
    boxShadow: `8px 8px 0 ${INK}`,
    padding: "40px 44px",
    maxWidth: 360,
    textAlign: "center",
  },
  logoBox: {
    width: 48,
    height: 48,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: ACCENT,
    border: `2px solid ${INK}`,
    boxShadow: `3px 3px 0 ${INK}`,
  },
  logoMark: { fontWeight: 900, fontSize: 22, lineHeight: 1 },
  title: { fontSize: 24, fontWeight: 900, letterSpacing: "-0.02em", textTransform: "uppercase", margin: 0 },
  subtitle: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "#555",
    margin: 0,
  },
  error: {
    fontFamily: MONO,
    fontSize: 11,
    color: "#dc2626",
    fontWeight: 700,
    lineHeight: 1.6,
    margin: 0,
  },
  button: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: ACCENT,
    color: INK,
    border: `3px solid ${INK}`,
    boxShadow: `5px 5px 0 ${INK}`,
    padding: "14px 24px",
    fontFamily: MONO,
    fontSize: 13,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    cursor: "pointer",
    marginTop: 8,
  },
};
