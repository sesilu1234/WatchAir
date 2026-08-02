"use client";
import { useEffect, useRef, useState } from "react";
import { buildServer2WsUrl } from "./api";

export type WsStatus = "connecting" | "connected" | "disconnected" | "error";

const RECONNECT_MS = 2000;

// WS de solo lectura contra server2, con reconexión automática. Cada
// (re)conexión pide un token nuevo a server1 (buildServer2WsUrl): si el
// cierre fue por token caducado, el próximo intento ya lleva uno fresco.
// `onOpen` se dispara en cada (re)conexión: es el momento de re-sincronizar
// el estado, porque mientras el socket estaba caído nos hemos perdido los
// avisos de servidor.
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

    const connect = async () => {
      let url: string;
      try {
        url = await buildServer2WsUrl();
      } catch {
        if (disposed) return;
        setStatus("error");
        retry = setTimeout(connect, RECONNECT_MS);
        return;
      }
      if (disposed) return;

      ws = new WebSocket(url);
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
