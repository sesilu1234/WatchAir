"use client";
import { useEffect, useRef, useState } from "react";
import { WS_FRONTEND_URL } from "./api";

export type WsStatus = "connecting" | "connected" | "disconnected" | "error";

const RECONNECT_MS = 2000;

// WS de solo lectura contra el backend, con reconexión automática.
// `onOpen` se dispara en cada (re)conexión: es el momento de re-sincronizar
// el estado por HTTP, porque mientras el socket estaba caído nos hemos perdido
// los avisos de inicio/fin de grabación.
export function useFrontendSocket({
  onMessage,
  onOpen,
}: {
  onMessage: (data: unknown) => void;
  onOpen?: () => void;
}): WsStatus {
  const [status, setStatus] = useState<WsStatus>("connecting");
  const callbacks = useRef({ onMessage, onOpen });

  useEffect(() => {
    callbacks.current = { onMessage, onOpen };
  });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      ws = new WebSocket(WS_FRONTEND_URL);
      ws.onopen = () => {
        setStatus("connected");
        callbacks.current.onOpen?.();
      };
      ws.onmessage = (ev) => {
        try {
          callbacks.current.onMessage(JSON.parse(ev.data));
        } catch {}
      };
      ws.onerror = () => setStatus("error");
      ws.onclose = () => {
        if (disposed) return;
        setStatus("disconnected");
        retry = setTimeout(connect, RECONNECT_MS);
      };
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return status;
}
