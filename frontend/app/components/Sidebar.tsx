"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ACCENT, INK, MONO, PAPER } from "../theme";
import { useCompact } from "../lib/useCompact";

const STORAGE_KEY = "watchair:sidebar-collapsed";
const EXPANDED_WIDTH = 236;
const COLLAPSED_WIDTH = 76;

type NavItem = {
  href: string;
  label: string;
  icon: (props: { active: boolean }) => ReactNode;
};

const NAV_ITEMS: NavItem[] = [
  { href: "/realtime", label: "Real-Time", icon: RealtimeIcon },
  { href: "/recordings", label: "Recordings", icon: RecordingsIcon },
];

export default function Sidebar() {
  const pathname = usePathname();
  const compact = useCompact();
  const [collapsed, setCollapsed] = useState(false);
  const [toggleHovered, setToggleHovered] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) !== "true") return;

    const frame = requestAnimationFrame(() => setCollapsed(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  };

  const isActive = (href: string) => pathname === href || !!pathname?.startsWith(`${href}/`);

  // En móvil la columna lateral se comería media pantalla: se cambia por una
  // barra de pestañas abajo (globals.css la coloca ahí con column-reverse).
  if (compact) {
    return (
      <nav style={m.bar}>
        {NAV_ITEMS.map((item) => {
          const active = isActive(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{ ...m.tab, ...(active ? m.tabActive : null) }}
            >
              <Icon active={active} />
              <span style={m.tabLabel}>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    <aside style={{ ...s.aside, width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}>
      {/* Marca */}
      <div style={s.brand}>
        <div style={s.logoBox}>
          <span style={s.logoMark}>W</span>
        </div>
        <FadeText collapsed={collapsed}>
          <p style={s.brandTitle}>WatchAir</p>
          <p style={s.brandSubtitle}>Respiratory Monitor</p>
        </FadeText>
      </div>

      <div style={s.divider} />

      {/* Navegación */}
      <nav style={s.nav}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.href}
            item={item}
            active={isActive(item.href)}
            collapsed={collapsed}
          />
        ))}
      </nav>

      {/* Usuario */}
      <div style={{ ...s.userRow, ...(collapsed ? s.navItemCollapsed : null) }}>
        <div style={s.avatar}>U</div>
        <FadeText collapsed={collapsed}>
          <span style={s.userName}>Usuario</span>
        </FadeText>
      </div>

      {/* Botón de colapso, en el borde */}
      <button
        type="button"
        onClick={toggle}
        onMouseEnter={() => setToggleHovered(true)}
        onMouseLeave={() => setToggleHovered(false)}
        style={{
          ...s.edgeToggle,
          ...(toggleHovered ? s.edgeToggleHover : null),
        }}
        aria-label={collapsed ? "Expandir sidebar" : "Colapsar sidebar"}
      >
        <ChevronIcon collapsed={collapsed} color={toggleHovered ? PAPER : INK} />
      </button>
    </aside>
  );
}

function NavLink({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const [hover, setHover] = useState(false);
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...s.navItem,
        ...(collapsed ? s.navItemCollapsed : null),
        ...(active ? s.navItemActive : hover ? s.navItemHover : null),
      }}
    >
      <Icon active={active} />
      <FadeText collapsed={collapsed}>
        <span style={s.navLabel}>{item.label}</span>
      </FadeText>
    </Link>
  );
}

// Envuelve el contenido que debe desvanecerse/ocultarse al colapsar la sidebar.
function FadeText({
  collapsed,
  children,
}: {
  collapsed: boolean;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        minWidth: 0,
        overflow: "hidden",
        opacity: collapsed ? 0 : 1,
        maxWidth: collapsed ? 0 : 180,
        transition: "opacity 0.15s ease, max-width 0.2s ease",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </div>
  );
}

// --- Iconos ---

function RealtimeIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M3 12h3l2-7 4 14 2-7h7"
        stroke={INK}
        strokeWidth={active ? 2.5 : 2}
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

function RecordingsIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <rect
        x="3"
        y="5"
        width="13"
        height="14"
        stroke={INK}
        strokeWidth={active ? 2.5 : 2}
      />
      <path
        d="M16.5 10 21 7.5v9L16.5 14"
        stroke={INK}
        strokeWidth={active ? 2.5 : 2}
        strokeLinejoin="miter"
      />
    </svg>
  );
}

function ChevronIcon({ collapsed, color }: { collapsed: boolean; color: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      style={{ transform: collapsed ? "rotate(180deg)" : undefined }}
    >
      <path
        d="M15 5l-7 7 7 7"
        stroke={color}
        strokeWidth="3"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

// --- Estilos ---
const s: Record<string, CSSProperties> = {
  aside: {
    position: "relative",
    flexShrink: 0,
    height: "100%",
    display: "flex",
    flexDirection: "column",
    background: PAPER,
    color: INK,
    borderRight: "1px solid rgba(17,17,17,0.16)",
    boxShadow: "6px 0 18px rgba(17,17,17,0.025)",
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    transition: "width 0.2s ease",
  },
  brand: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "18px",
    minHeight: 78,
    boxSizing: "border-box",
    overflow: "hidden",
  },
  divider: {
    flexShrink: 0,
    height: 1,
    margin: "0 18px",
    background: "rgba(17,17,17,0.12)",
  },
  logoBox: {
    flexShrink: 0,
    width: 36,
    height: 36,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: ACCENT,
    border: `2px solid ${INK}`,
    boxShadow: `3px 3px 0 ${INK}`,
  },
  logoMark: {
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    fontWeight: 900,
    fontSize: 16,
    color: INK,
    lineHeight: 1,
  },
  brandTitle: {
    fontSize: 16,
    fontWeight: 900,
    letterSpacing: "-0.02em",
    textTransform: "uppercase",
    margin: 0,
    lineHeight: 1.15,
  },
  brandSubtitle: {
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: 700,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#666",
    margin: "3px 0 0 0",
  },
  nav: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "16px 12px",
    overflowY: "auto",
    overflowX: "hidden",
  },
  navItem: {
    position: "relative",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    borderRadius: 10,
    border: "2px solid transparent",
    color: INK,
    textDecoration: "none",
    boxSizing: "border-box",
    transition: "background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease",
  },
  navItemCollapsed: {
    justifyContent: "center",
    padding: "10px",
  },
  navItemHover: {
    background: "rgba(17,17,17,0.05)",
  },
  navItemActive: {
    background: ACCENT,
    border: `2px solid ${INK}`,
    borderRadius: 8,
    boxShadow: `2px 2px 0 ${INK}`,
  },
  navLabel: {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
  },
  userRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "14px 16px",
    boxSizing: "border-box",
  },
  avatar: {
    flexShrink: 0,
    width: 32,
    height: 32,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#ffffff",
    border: `2px solid ${INK}`,
    fontFamily: MONO,
    fontWeight: 700,
    fontSize: 13,
  },
  userName: {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
  },
  edgeToggle: {
    position: "absolute",
    top: 68,
    right: -14,
    width: 28,
    height: 28,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: PAPER,
    border: `2px solid ${INK}`,
    borderRadius: "50%",
    boxShadow: `2px 2px 0 ${INK}`,
    cursor: "pointer",
    padding: 0,
    zIndex: 5,
    transition: "background-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease",
  },
  edgeToggleHover: {
    background: INK,
    boxShadow: `3px 3px 0 ${INK}`,
    transform: "translate(-1px, -1px)",
  },
};

// --- Estilos de la barra inferior (móvil) ---
const m: Record<string, CSSProperties> = {
  bar: {
    flexShrink: 0,
    display: "flex",
    background: PAPER,
    borderTop: `2px solid ${INK}`,
    boxShadow: "0 -6px 18px rgba(17,17,17,0.05)",
    // safe-area: el gesto de "atrás" de Android y la barra del iPhone.
    paddingBottom: "env(safe-area-inset-bottom)",
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
  },
  tab: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    padding: "9px 6px",
    minHeight: 54,
    boxSizing: "border-box",
    color: INK,
    textDecoration: "none",
    borderTop: "3px solid transparent",
  },
  tabActive: {
    background: ACCENT,
    borderTop: `3px solid ${INK}`,
  },
  tabLabel: {
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    lineHeight: 1,
  },
};
