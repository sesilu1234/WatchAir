"use client";
import { useEffect, useRef, useState } from "react";
import { buildServer2WsUrl } from "./api";

export type WsStatus = "connecting" | "connected" | "disconnected" | "error";

const RECONNECT_MS = 2000;
// Con la ESP32 conectada siempre llega algo: su `status` cada 2 s, y las
// muestras si se pidió `live`. Este silencio significa que no queda ninguna
// prueba de que siga ahí — puede haberse caído ella, el server, o la red de
// este navegador sin que el socket llegue a enterarse.
const SILENCE_MS = 7000;

// WS de solo lectura contra server2, con reconexión automática. Cada
// (re)conexión pide un token nuevo a server1 (buildServer2WsUrl): si el
// cierre fue por token caducado, el próximo intento ya lleva uno fresco.
// `onOpen` se dispara en cada (re)conexión: es el momento de re-sincronizar
// el estado, porque mientras el socket estaba caído nos hemos perdido los
// avisos de servidor.
// `live` pide además las muestras en vivo; sin él server2 no pone a emitir a la
// ESP32, así que solo lo usa quien pinta la señal.
// `fresh` es false cuando lleva SILENCE_MS sin llegar nada: el aparato se da por
// desconectado aunque el socket siga formalmente abierto. El `device_offline`
// del server es la vía rápida para lo mismo; esto es la red de seguridad.
export function useFrontendSocket({
  onMessage,
  onOpen,
  live = false,
}: {
  onMessage: (data: unknown) => void;
  onOpen?: () => void;
  live?: boolean;
}): { status: WsStatus; fresh: boolean } {
  const [status, setStatus] = useState<WsStatus>("connecting");
  const [fresh, setFresh] = useState(true);
  const lastSignalAt = useRef(Date.now()); // 0 = el canal está caído
  const callbacks = useRef({ onMessage, onOpen });

  useEffect(() => {
    callbacks.current = { onMessage, onOpen };
  });

  // El silencio se mide contra el reloj, no con la duración de un temporizador:
  // al suspenderse el equipo (o al pasar la pestaña a segundo plano) los timers
  // se congelan, y uno "de 7 s" no mediría 7 s reales.
  useEffect(() => {
    const check = () => setFresh(Date.now() - lastSignalAt.current < SILENCE_MS);
    const drop = () => {
      lastSignalAt.current = 0;
      check();
    };
    const id = setInterval(check, 1000);
    // Al volver de una suspensión o de un cambio de red, comprobarlo ya en vez
    // de esperar al siguiente tick.
    document.addEventListener("visibilitychange", check);
    window.addEventListener("online", check);
    window.addEventListener("offline", drop);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("online", check);
      window.removeEventListener("offline", drop);
    };
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = async () => {
      let url: string;
      try {
        url = await buildServer2WsUrl(live);
      } catch {
        lastSignalAt.current = 0;
        if (disposed) return;
        setStatus("error");
        retry = setTimeout(connect, RECONNECT_MS);
        return;
      }
      if (disposed) return;

      ws = new WebSocket(url);
      ws.onopen = () => {
        lastSignalAt.current = Date.now(); // el margen de silencio arranca aquí
        setStatus("connected");
        callbacks.current.onOpen?.();
      };
      ws.onmessage = (ev) => {
        lastSignalAt.current = Date.now();
        try {
          callbacks.current.onMessage(JSON.parse(ev.data));
        } catch {}
      };
      ws.onerror = () => setStatus("error");
      ws.onclose = () => {
        lastSignalAt.current = 0;
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
  }, [live]);

  return { status, fresh };
}
