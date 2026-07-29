"use client";
import { useCallback, useEffect, useState, type RefObject } from "react";

// Safari usa todavía el prefijo; en el iPhone la API no existe para elementos
// que no sean <video>, así que todo esto puede fallar y hay que sobrevivirlo.
type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

const fullscreenElement = () => {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
};

// Pantalla completa de un elemento. `active` es el estado que manda: si el
// navegador no soporta la API (iPhone) se queda en true igualmente y el que
// llama pinta el elemento a pantalla completa con position:fixed.
export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [active, setActive] = useState(false);

  // Salidas que no controlamos: Esc, el gesto "atrás" de Android o el botón del
  // propio navegador. Sin esto el estado se quedaría creyendo que sigue abierto.
  useEffect(() => {
    if (!active) return;

    const sync = () => fullscreenElement() === null && setActive(false);
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && setActive(false);

    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [active]);

  const toggle = useCallback(() => {
    const el = ref.current as FullscreenElement | null;
    const doc = document as FullscreenDocument;

    if (active) {
      setActive(false);
      if (fullscreenElement() !== null) {
        Promise.resolve(doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.()).catch(() => {});
      }
      return;
    }

    setActive(true);
    // navigationUI: "hide" esconde también la barra del navegador en Android.
    Promise.resolve(
      el?.requestFullscreen?.({ navigationUI: "hide" }) ?? el?.webkitRequestFullscreen?.(),
    ).catch(() => {});
  }, [active, ref]);

  return { active, toggle };
}
