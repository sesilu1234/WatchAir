"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { ACCENT, INK, MONO, PAPER } from "../theme";
import { useCompact } from "../lib/useCompact";
import type { Device } from "../lib/api";

// Filtros del historial. Los controles nativos (`<select>`, `<input type=date>`)
// los pinta el sistema operativo y no hay forma de que peguen con el resto, así
// que aquí van sus dos equivalentes propios: una lista y un calendario, ambos en
// un popover que cuelga del campo.
//
// La fecha se maneja siempre como texto `YYYY-MM-DD` — nunca como `Date` — para
// no arrastrar husos horarios: es la misma cadena con la que se compara
// `started_at` en la lista.

const MONTHS = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
// Semana de lunes a domingo, que es como se lee un calendario aquí.
const WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"];

const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
const keyOf = (d: Date) => dateKey(d.getFullYear(), d.getMonth(), d.getDate());

// "2026-03-14" → "14 MAR 2026"
const prettyDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return `${d} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
};

export default function FilterBar({
  devices,
  deviceUuid,
  date,
  availableDates,
  onDeviceChange,
  onDateChange,
}: {
  devices: Device[];
  deviceUuid: string;
  date: string;
  /** Días con grabaciones, en `YYYY-MM-DD`: el calendario los marca con un punto. */
  availableDates: Set<string>;
  onDeviceChange: (v: string) => void;
  onDateChange: (v: string) => void;
}) {
  const compact = useCompact();
  // Solo un popover abierto a la vez: abrir uno cierra el otro.
  const [open, setOpen] = useState<"device" | "date" | null>(null);
  const close = useCallback(() => setOpen(null), []);

  const deviceName = devices.find((d) => d.uuid === deviceUuid)?.username;
  const fieldStyle = compact ? mobile.field : null;

  return (
    <div style={styles.bar}>
      <Field
        icon={<UserIcon />}
        value={deviceName ?? "Todos los usuarios"}
        active={deviceUuid !== ""}
        open={open === "device"}
        onToggle={() => setOpen((o) => (o === "device" ? null : "device"))}
        onClose={close}
        style={fieldStyle}
      >
        <DeviceList
          devices={devices}
          value={deviceUuid}
          onPick={(v) => {
            onDeviceChange(v);
            close();
          }}
        />
      </Field>

      <Field
        icon={<CalendarIcon />}
        value={date ? prettyDate(date) : "Cualquier fecha"}
        active={date !== ""}
        open={open === "date"}
        onToggle={() => setOpen((o) => (o === "date" ? null : "date"))}
        onClose={close}
        style={fieldStyle}
      >
        <Calendar
          value={date}
          availableDates={availableDates}
          onPick={(v) => {
            onDateChange(v);
            close();
          }}
        />
      </Field>

      {(deviceUuid || date) && (
        <ClearButton
          onClick={() => {
            onDeviceChange("");
            onDateChange("");
            close();
          }}
        />
      )}
    </div>
  );
}

// --- Campo + popover ---

function Field({
  icon,
  value,
  active,
  open,
  onToggle,
  onClose,
  style,
  children,
}: {
  icon: ReactNode;
  value: string;
  active: boolean;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  style?: CSSProperties | null;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Clic fuera y Escape cierran. `pointerdown` y no `click` para que cerrar no
  // dispare de paso lo que hubiera debajo.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={ref} style={{ ...styles.fieldWrap, ...style }}>
      <button
        type="button"
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          ...styles.field,
          ...(active ? styles.fieldActive : null),
          ...(open || hover ? styles.fieldRaised : null),
        }}
      >
        <span style={{ ...styles.fieldIcon, color: active ? INK : "#4a4a4a" }}>{icon}</span>
        <span style={{ ...styles.fieldValue, color: active ? INK : "#3d3d3d" }}>{value}</span>
        <span style={{ ...styles.chevron, transform: open ? "rotate(180deg)" : "none" }}>
          <ChevronDown />
        </span>
      </button>
      {open && (
        <div role="dialog" style={styles.popover}>
          {children}
        </div>
      )}
    </div>
  );
}

// --- Lista de usuarios ---

function DeviceList({
  devices,
  value,
  onPick,
}: {
  devices: Device[];
  value: string;
  onPick: (v: string) => void;
}) {
  const options = useMemo(
    () => [{ uuid: "", username: "Todos los usuarios" }, ...devices],
    [devices],
  );
  const listRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(() =>
    Math.max(0, options.findIndex((o) => o.uuid === value)),
  );

  // El foco se va al popover al abrirlo: si no, las flechas seguirían moviendo
  // el scroll de la página en vez de la lista.
  useEffect(() => listRef.current?.focus(), []);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.min(options.length - 1, Math.max(0, c + (e.key === "ArrowDown" ? 1 : -1))));
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onPick(options[cursor].uuid);
    }
  };

  return (
    <div
      ref={listRef}
      role="listbox"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={styles.list}
    >
      {options.map((o, i) => {
        const selected = o.uuid === value;
        return (
          <button
            key={o.uuid || "all"}
            type="button"
            role="option"
            aria-selected={selected}
            onMouseEnter={() => setCursor(i)}
            onClick={() => onPick(o.uuid)}
            style={{
              ...styles.option,
              ...(cursor === i ? styles.optionHover : null),
              ...(selected ? styles.optionSelected : null),
            }}
          >
            <span style={styles.optionText}>{o.username}</span>
            {selected && <CheckIcon />}
          </button>
        );
      })}
    </div>
  );
}

// --- Calendario ---

function Calendar({
  value,
  availableDates,
  onPick,
}: {
  value: string;
  availableDates: Set<string>;
  onPick: (v: string) => void;
}) {
  const today = keyOf(new Date());
  // Se abre por el mes de la fecha elegida, o por el actual si no hay ninguna.
  const [view, setView] = useState(() => {
    const [y, m] = (value || today).split("-").map(Number);
    return { year: y, month: m - 1 };
  });

  const shift = (delta: number) =>
    setView(({ year, month }) => {
      const d = new Date(year, month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  const { year, month } = view;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  // getDay() cuenta desde el domingo; la rejilla empieza en lunes.
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;

  return (
    <div style={styles.calendar}>
      <div style={styles.calHeader}>
        <NavButton label="Mes anterior" onClick={() => shift(-1)}>
          <ChevronLeft />
        </NavButton>
        <span style={styles.calMonth}>
          {MONTHS[month]} {year}
        </span>
        <NavButton label="Mes siguiente" onClick={() => shift(1)}>
          <ChevronRight />
        </NavButton>
      </div>

      <div style={styles.calGrid}>
        {WEEKDAYS.map((w, i) => (
          <span key={i} style={styles.calWeekday}>
            {w}
          </span>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={`pad-${i}`} />
        ))}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const key = dateKey(year, month, i + 1);
          return (
            <CalendarDay
              key={key}
              day={i + 1}
              selected={key === value}
              isToday={key === today}
              hasData={availableDates.has(key)}
              onClick={() => onPick(key === value ? "" : key)}
            />
          );
        })}
      </div>

      <div style={styles.calFooter}>
        <FooterButton
          label="Hoy"
          onClick={() => {
            const [y, m] = today.split("-").map(Number);
            setView({ year: y, month: m - 1 });
            onPick(today);
          }}
        />
        {value !== "" && <FooterButton label="Quitar fecha" onClick={() => onPick("")} />}
      </div>
    </div>
  );
}

function CalendarDay({
  day,
  selected,
  isToday,
  hasData,
  onClick,
}: {
  day: number;
  selected: boolean;
  isToday: boolean;
  hasData: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={selected}
      style={{
        ...styles.calDay,
        ...(isToday ? styles.calDayToday : null),
        ...(hover && !selected ? styles.calDayHover : null),
        ...(selected ? styles.calDaySelected : null),
        // Un día sin grabaciones se puede elegir igual (la lista dirá que no hay
        // nada), pero se pinta más flojo para no invitar a ello. Lo justo para
        // que se note la diferencia sin que parezca deshabilitado.
        color: hasData || selected ? INK : "#8f8f8f",
      }}
    >
      {day}
      {hasData && (
        <span style={{ ...styles.calDot, background: selected ? INK : ACCENT }} />
      )}
    </button>
  );
}

// --- Piezas sueltas ---

function NavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...styles.navButton, background: hover ? ACCENT : PAPER }}
    >
      {children}
    </button>
  );
}

function FooterButton({ label, onClick }: { label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ ...styles.footerButton, background: hover ? ACCENT : "transparent" }}
    >
      {label}
    </button>
  );
}

function ClearButton({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...styles.clear,
        color: hover ? INK : "#555",
        borderColor: hover ? INK : "rgba(17,17,17,0.4)",
      }}
    >
      <CloseIcon />
      Limpiar
    </button>
  );
}

// --- Iconos ---

function UserIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="8" r="3.5" stroke="currentColor" strokeWidth="2" />
      <path d="M5 20c0-3.5 3.1-5.5 7-5.5s7 2 7 5.5" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="18" height="16" stroke="currentColor" strokeWidth="2" />
      <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none">
      <path d="M5 9l7 7 7-7" stroke="currentColor" strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <path d="M15 5l-7 7 7 7" stroke={INK} strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
      <path d="M9 5l7 7-7 7" stroke={INK} strokeWidth="3" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M4 12.5l5 5L20 6.5" stroke={INK} strokeWidth="3.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="none">
      <path d="M5 5l14 14M19 5L5 19" stroke="currentColor" strokeWidth="3" strokeLinecap="square" />
    </svg>
  );
}

// --- Estilos ---
const styles: Record<string, CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
    flexShrink: 0,
    flexWrap: "wrap",
  },
  // El popover cuelga de aquí, así que el campo es el que lleva `relative`.
  fieldWrap: { position: "relative" },
  // Borde en propiedades sueltas y no en el atajo `border`: los estados de
  // abajo solo cambian el color, y mezclar las dos formas hace que React avise
  // (y que el borde parpadee al quitar una de las dos).
  field: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    boxSizing: "border-box",
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    background: PAPER,
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: "rgba(17,17,17,0.45)",
    borderRadius: 10,
    boxShadow: "none",
    padding: "8px 12px",
    cursor: "pointer",
    transition: "border-color 0.15s ease, box-shadow 0.15s ease, background-color 0.15s ease",
  },
  // Con filtro puesto el campo se pinta del acento a saco. Teñirlo por encima
  // del papel lo dejaba tan pálido que parecía un botón desactivado.
  fieldActive: {
    background: ACCENT,
    borderColor: INK,
    boxShadow: `2px 2px 0 ${INK}`,
  },
  // Abierto y en hover se comportan igual: el campo se levanta del papel.
  fieldRaised: {
    borderColor: INK,
    boxShadow: `3px 3px 0 ${INK}`,
  },
  fieldIcon: { display: "flex", flexShrink: 0 },
  fieldValue: {
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  chevron: {
    display: "flex",
    flexShrink: 0,
    marginLeft: "auto",
    color: "#555",
    transition: "transform 0.18s ease",
  },
  popover: {
    position: "absolute",
    top: "calc(100% + 6px)",
    left: 0,
    zIndex: 30,
    background: "#ffffff",
    border: `2px solid ${INK}`,
    borderRadius: 12,
    boxShadow: `5px 5px 0 ${INK}`,
    padding: 6,
  },

  list: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 210,
    maxHeight: 240,
    overflowY: "auto",
    outline: "none",
  },
  option: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    width: "100%",
    boxSizing: "border-box",
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    color: INK,
    background: "transparent",
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: 8,
    padding: "8px 10px",
    textAlign: "left",
    cursor: "pointer",
  },
  optionHover: { background: "rgba(17,17,17,0.09)" },
  optionSelected: { background: ACCENT, borderColor: INK },
  optionText: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
  },

  calendar: { width: 258, display: "flex", flexDirection: "column", gap: 8, padding: 2 },
  calHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 },
  calMonth: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 900,
    color: INK,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  navButton: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 26,
    height: 26,
    border: `1.5px solid ${INK}`,
    borderRadius: 8,
    padding: 0,
    cursor: "pointer",
    transition: "background-color 0.15s ease",
  },
  calGrid: { display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 },
  calWeekday: {
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: 800,
    color: "#6f6f6f",
    textAlign: "center",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    paddingBottom: 4,
  },
  calDay: {
    position: "relative",
    height: 30,
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    color: INK,
    background: "transparent",
    borderWidth: 1.5,
    borderStyle: "solid",
    borderColor: "transparent",
    borderRadius: 8,
    padding: 0,
    cursor: "pointer",
    transition: "background-color 0.12s ease, border-color 0.12s ease",
  },
  calDayHover: { background: "rgba(17,17,17,0.1)" },
  calDayToday: { borderColor: "rgba(17,17,17,0.55)" },
  calDaySelected: { background: ACCENT, borderColor: INK, fontWeight: 900 },
  calDot: {
    position: "absolute",
    left: "50%",
    bottom: 4,
    width: 4,
    height: 4,
    marginLeft: -2,
    borderRadius: "50%",
  },
  calFooter: {
    display: "flex",
    gap: 6,
    borderTop: "1px solid rgba(17,17,17,0.12)",
    paddingTop: 8,
  },
  footerButton: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 800,
    color: INK,
    border: `1.5px solid ${INK}`,
    borderRadius: 8,
    padding: "6px 8px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    cursor: "pointer",
    transition: "background-color 0.15s ease",
  },

  clear: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 700,
    background: "transparent",
    borderWidth: 1.5,
    borderStyle: "solid",
    borderRadius: 10,
    padding: "8px 12px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    cursor: "pointer",
    transition: "color 0.15s ease, border-color 0.15s ease",
  },
};

// Móvil: campos a lo ancho. Además de leerse mejor, deja al popover sitio de
// sobra para desplegarse sin salirse por el lado derecho de la pantalla.
const mobile: Record<string, CSSProperties> = {
  field: { flex: "1 1 100%" },
};
