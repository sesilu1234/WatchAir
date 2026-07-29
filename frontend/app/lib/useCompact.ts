"use client";
import { useSyncExternalStore } from "react";

// "Compacto" = móvil, tablet en vertical o ventana muy baja (móvil en horizontal).
// La misma media query está duplicada en globals.css para la barra de navegación
// inferior: si se toca una, hay que tocar la otra.
export const COMPACT_QUERY = "(max-width: 899.98px), (max-height: 559.98px)";

let mediaQuery: MediaQueryList | null = null;
const media = () => (mediaQuery ??= window.matchMedia(COMPACT_QUERY));

const subscribe = (onChange: () => void) => {
  const mql = media();
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
};

// En el server no hay pantalla: se asume escritorio y React corrige tras hidratar.
// Con useSyncExternalStore ese ajuste no cuenta como desajuste de hidratación.
export function useCompact(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media().matches,
    () => false,
  );
}
