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
// lock() no está en lib.dom porque Safari no lo implementa; unlock() sí lo está.
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: "landscape") => Promise<void>;
};

const fullscreenElement = () => {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
};

const orientation = () => screen.orientation as LockableOrientation | undefined;

// Salir de pantalla completa ya libera la orientación por especificación, pero
// hacerlo explícito evita dejar el móvil girado si algún navegador no cumple.
const unlockOrientation = () => {
  try {
    orientation()?.unlock();
  } catch {}
};

// Pantalla completa de un elemento. `active` es el estado que manda: si el
// navegador no soporta la API (iPhone) se queda en true igualmente y el que
// llama pinta el elemento a pantalla completa con position:fixed.
//
// `landscape` pide además girar la pantalla, para lo que sirva: sólo funciona
// en móvil (Android), es el navegador quien decide y el usuario puede salir
// cuando quiera. Si no cuela, se queda tal cual estaba.
export function useFullscreen(
  ref: RefObject<HTMLElement | null>,
  { landscape = false }: { landscape?: boolean } = {},
) {
  const [active, setActive] = useState(false);

  // Salidas que no controlamos: Esc, el gesto "atrás" de Android o el botón del
  // propio navegador. Sin esto el estado se quedaría creyendo que sigue abierto.
  useEffect(() => {
    if (!active) return;

    const close = () => {
      unlockOrientation();
      setActive(false);
    };
    const sync = () => fullscreenElement() === null && close();
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && close();

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
      unlockOrientation();
      if (fullscreenElement() !== null) {
        Promise.resolve(doc.exitFullscreen?.() ?? doc.webkitExitFullscreen?.()).catch(() => {});
      }
      return;
    }

    setActive(true);
    // navigationUI: "hide" esconde también la barra del navegador en Android.
    Promise.resolve(
      el?.requestFullscreen?.({ navigationUI: "hide" }) ?? el?.webkitRequestFullscreen?.(),
    )
      // Encadenado y no en paralelo: girar la pantalla exige estar ya en
      // pantalla completa. Si algo falla, el catch se lo come y sigue en pie.
      .then(() => {
        if (landscape) return orientation()?.lock?.("landscape");
      })
      .catch(() => {});
  }, [active, landscape, ref]);

  return { active, toggle };
}
