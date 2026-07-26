"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ACCENT, INK, MONO, PAPER } from "../theme";

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
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) === "true") setCollapsed(true);
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  };

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
        {NAV_ITEMS.map((item) => {
          const active =
            pathname === item.href || pathname?.startsWith(`${item.href}/`);
          return (
            <NavLink
              key={item.href}
              item={item}
              active={!!active}
              collapsed={collapsed}
            />
          );
        })}
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
        style={s.edgeToggle}
        aria-label={collapsed ? "Expandir sidebar" : "Colapsar sidebar"}
      >
        <ChevronIcon collapsed={collapsed} />
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
      {active && <span style={s.activeBar} />}
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

function ChevronIcon({ collapsed }: { collapsed: boolean }) {
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
        stroke={INK}
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
    borderRight: `3px solid ${INK}`,
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
    color: INK,
    textDecoration: "none",
    boxSizing: "border-box",
    transition: "background-color 0.15s ease",
  },
  navItemCollapsed: {
    justifyContent: "center",
    padding: "10px",
  },
  navItemHover: {
    background: "rgba(17,17,17,0.05)",
  },
  navItemActive: {
    background: "rgba(0,224,168,0.18)",
  },
  activeBar: {
    position: "absolute",
    left: 2,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
    background: ACCENT,
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
    boxShadow: `2px 2px 0 ${INK}`,
    cursor: "pointer",
    padding: 0,
    zIndex: 5,
  },
};
