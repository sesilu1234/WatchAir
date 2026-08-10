"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ACCENT, INK, MONO, PAPER } from "../theme";
import {
  deleteRecordings,
  isDeviceOnline,
  isDeviceStatus,
  isRecordingFinished,
  listDevices,
  listRecordings,
  renameRecording,
  startRecording,
  stopRecording,
  type Device,
  type DeviceStatusMessage,
  type Recording,
} from "../lib/api";
import { useCompact } from "../lib/useCompact";
import { useFrontendSocket, type WsStatus } from "../lib/useFrontendSocket";
import {
  displayName,
  durationSeconds,
  formatClock,
  formatRelativeDate,
  formatTime,
  recordingName,
} from "../lib/format";
import DeleteDialog from "./DeleteDialog";
import FilterBar from "./Filters";

// Nada de deducir estados: lo que hace el aparato sale entero del `status` que
// manda la ESP32 (cada 2 s y en cuanto algo cambia). Sin conexión con ella no se
// sabe nada de nada, y eso es exactamente lo que se enseña.
//
// La lista de abajo son solo grabaciones YA subidas: la fila no existe hasta que
// el fichero llega al server, así que la que está en curso vive únicamente en el
// status y nunca aparece en el historial.
export default function RecordingsPage() {
  const compact = useCompact();

  const [reportedOnline, setReportedOnline] = useState<boolean | null>(null);
  const [reportedStatus, setReportedStatus] = useState<DeviceStatusMessage | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = todavía no ha contestado el primer fetch. No es lo mismo que una
  // lista vacía, y hasta ahora se enseñaban igual: "no hay grabaciones" mientras
  // cargaba, y para siempre si la llamada fallaba.
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [filterDeviceUuid, setFilterDeviceUuid] = useState("");
  const [filterDate, setFilterDate] = useState("");

  // Borrado: `selecting` enseña las casillas, `confirming` son los uuid que ya
  // están delante del diálogo esperando a que se escriba la frase.
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Qué fila tiene abiertas sus acciones, y cuál. Vive aquí y no en la fila para
  // que solo pueda haber una a la vez y para poder cerrarla desde fuera (al
  // entrar en modo selección, o al borrar).
  const [rowAction, setRowAction] = useState<{ uuid: string; kind: RowAction } | null>(null);

  const refresh = useCallback(() => {
    listRecordings()
      .then((rows) => {
        setRecordings(rows);
        setListError(null);
      })
      .catch((err) => {
        console.error(err);
        setListError(err instanceof Error ? err.message : String(err));
      });
    listDevices()
      .then(setDevices)
      .catch((err) => console.error(err));
  }, []);

  useEffect(refresh, [refresh]);

  const handleMessage = useCallback(
    (data: unknown) => {
      if (isDeviceOnline(data)) {
        const online = data.type === "device_online";
        setReportedOnline(online);
        // Desconectada: se descarta el último status en vez de dejarlo pintado.
        // Lo que dijera hace un rato ya no dice nada de lo que pasa ahora.
        if (!online) setReportedStatus(null);
        return;
      }
      if (isDeviceStatus(data)) {
        setReportedStatus(data);
        return;
      }
      if (isRecordingFinished(data)) {
        // Ya hay fila: es el único momento en que el historial cambia.
        refresh();
      }
    },
    [refresh],
  );

  // Sin `live`: aquí no se pinta ninguna gráfica, así que no se pide emisión.
  const { status: wsStatus, fresh } = useFrontendSocket({
    onMessage: handleMessage,
    onOpen: refresh,
  });

  // Mismo criterio que con `device_offline`, solo que por silencio: sin noticias
  // frescas no se sabe nada del aparato, y su último status ya no dice nada de
  // lo que pasa ahora.
  const deviceOnline = fresh ? reportedOnline : false;
  const status = fresh ? reportedStatus : null;

  const startedEpochMs = status?.rec_started_epoch_ms ?? null;
  const recording = status?.rec_uuid != null;
  const uploading = status?.uploading ?? false;

  // Cronómetro de la grabación en curso, contra el t=0 que dice la ESP32 (el de
  // la cabecera del fichero). 250 ms para que al entrar el valor real aparezca
  // sin salto visible (React descarta el render si no cambia).
  useEffect(() => {
    if (startedEpochMs == null) return;
    const tick = () =>
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedEpochMs) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [startedEpochMs]);

  // No hace falta refrescar nada después: el siguiente status ya trae el estado
  // bueno, y las dos llamadas devuelven uno para no esperar ni a eso.
  const run = async (action: () => Promise<DeviceStatusMessage>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      setReportedStatus(await action());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const byDevice = useMemo(
    () => (recordings ?? []).filter((r) => !filterDeviceUuid || r.device_uuid === filterDeviceUuid),
    [recordings, filterDeviceUuid],
  );

  const history = useMemo(
    () => byDevice.filter((r) => !filterDate || r.started_at.slice(0, 10) === filterDate),
    [byDevice, filterDate],
  );

  // Los días que el calendario marca con un punto. Van del filtro de usuario,
  // no del total: con un usuario elegido, marcar días suyos y de otros mentiría.
  const availableDates = useMemo(
    () => new Set(byDevice.map((r) => r.started_at.slice(0, 10))),
    [byDevice],
  );

  // También al tocar los filtros: si no, quedarían marcadas grabaciones que ya
  // no se ven y el contador de arriba diría cosas raras.
  const clearSelection = () => setSelection(new Set());

  const enterSelection = () => {
    setSelecting(true);
    setRowAction(null); // marcar casillas y toquetear una fila son cosas distintas
  };

  const toggleOne = (uuid: string) =>
    setSelection((prev) => {
      const next = new Set(prev);
      if (!next.delete(uuid)) next.add(uuid);
      return next;
    });

  const allSelected = history.length > 0 && history.every((r) => selection.has(r.uuid));
  const toggleAll = () =>
    setSelection(allSelected ? new Set() : new Set(history.map((r) => r.uuid)));

  const leaveSelection = () => {
    setSelecting(false);
    clearSelection();
  };

  const confirmDelete = async () => {
    if (confirming == null || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteRecordings(confirming);
      setConfirming(null);
      setRowAction(null);
      leaveSelection();
      refresh();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <main style={{ ...styles.main, ...(compact ? mobile.main : null) }}>
      <header style={styles.header}>
        <h1 style={{ ...styles.title, ...(compact ? mobile.title : null) }}>Grabaciones</h1>
        <p style={styles.subtitle}>Historial de sesiones respiratorias · todas las cuentas</p>
      </header>

      <div style={{ ...styles.split, ...(compact ? mobile.split : null) }}>
        <div style={{ ...styles.topPane, ...(compact ? mobile.topPane : null) }}>
          {recording && startedEpochMs != null ? (
            <RecordingNowPanel
              startedEpochMs={startedEpochMs}
              elapsedSeconds={elapsedSeconds}
              deviceOnline={deviceOnline}
              wsStatus={wsStatus}
              pending={pending}
              error={error}
              onStop={() => run(stopRecording)}
            />
          ) : (
            <NewRecordingPanel
              deviceOnline={deviceOnline}
              wsStatus={wsStatus}
              pending={pending}
              uploading={uploading}
              uploadPercent={status?.upload_percent ?? null}
              pendingUploads={status?.pending ?? 0}
              error={error}
              onStart={() => run(startRecording)}
            />
          )}
        </div>

        <div style={{ ...styles.bottomPane, ...(compact ? mobile.bottomPane : null) }}>
          <div style={styles.listHeader}>
            <div style={styles.listTitleGroup}>
              <span style={styles.listTitleIcon}>
                <ArchiveIcon />
              </span>
              <span style={styles.listTitle}>Historial</span>
            </div>
            <div style={styles.listActions}>
              <span style={styles.listCountPill}>
                {selecting
                  ? `${selection.size} seleccionadas`
                  : recordings == null
                    ? "Cargando…"
                    : `${history.length} grabaciones`}
              </span>
              {selecting ? (
                <>
                  <SmallButton label={allSelected ? "Ninguna" : "Todas"} onClick={toggleAll} />
                  <SmallButton
                    label="Borrar"
                    danger
                    disabled={selection.size === 0}
                    onClick={() => {
                      setDeleteError(null);
                      setConfirming([...selection]);
                    }}
                  />
                  <SmallButton label="Cancelar" onClick={leaveSelection} />
                </>
              ) : (
                history.length > 0 && (
                  <SmallButton label="Seleccionar" onClick={enterSelection} />
                )
              )}
            </div>
          </div>

          <FilterBar
            devices={devices}
            deviceUuid={filterDeviceUuid}
            date={filterDate}
            availableDates={availableDates}
            onDeviceChange={(v) => {
              setFilterDeviceUuid(v);
              clearSelection();
            }}
            onDateChange={(v) => {
              setFilterDate(v);
              clearSelection();
            }}
          />

          <div style={styles.tableHead}>
            <span style={styles.tableHeadIconCol} />
            <span style={styles.tableHeadCell}>Grabación</span>
            <span style={styles.tableHeadCellRight}>Duración</span>
          </div>
          <div style={{ ...styles.rows, ...(compact ? mobile.rows : null) }}>
            {recordings == null ? (
              // Sin datos todavía: si el fetch falló se dice, y si sigue en
              // camino se enseñan filas fantasma. Un fallo de red que se refresca
              // más tarde no borra la lista que ya hubiera: por eso esto sólo
              // mira `recordings`, no `listError` a secas.
              listError != null ? (
                <div style={styles.empty}>
                  <span style={styles.emptyIcon}>
                    <WaveIcon />
                  </span>
                  No se pudo cargar el historial · {listError}
                </div>
              ) : (
                <LoadingRows />
              )
            ) : history.length === 0 ? (
              <div style={styles.empty}>
                <span style={styles.emptyIcon}>
                  <WaveIcon />
                </span>
                {recordings.length === 0 ? "Todavía no hay grabaciones." : "Nada con estos filtros."}
              </div>
            ) : (
              history.map((r) => (
                <RecordingRow
                  key={r.uuid}
                  recording={r}
                  selecting={selecting}
                  selected={selection.has(r.uuid)}
                  action={rowAction?.uuid === r.uuid ? rowAction.kind : null}
                  onAction={(kind) => setRowAction(kind == null ? null : { uuid: r.uuid, kind })}
                  onToggle={() => toggleOne(r.uuid)}
                  onDelete={() => {
                    setDeleteError(null);
                    setConfirming([r.uuid]);
                  }}
                  onRenamed={refresh}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {confirming != null && (
        <DeleteDialog
          count={confirming.length}
          pending={deleting}
          error={deleteError}
          onConfirm={confirmDelete}
          onCancel={() => {
            if (deleting) return;
            setConfirming(null);
            setDeleteError(null);
          }}
        />
      )}
    </main>
  );
}

// --- Filas fantasma mientras carga ---
//
// Tres filas con la misma forma que las de verdad, no una línea de texto: al
// llegar los datos la lista no da el salto de layout, y de un vistazo ya se ve
// que lo que va a aparecer ahí es una lista.
function LoadingRows() {
  return (
    <>
      <style>{skeletonCss}</style>
      {[0, 1, 2].map((i) => {
        // El desfase entre filas es lo que hace que se lea como "cargando" y no
        // como tres cajas grises parpadeando a la vez.
        const block = (extra: CSSProperties): CSSProperties => ({
          ...styles.skeletonBlock,
          ...extra,
          animationDelay: `${i * 0.12}s`,
        });
        return (
          <div key={i} style={styles.skeletonRow} aria-hidden>
            <span style={block({ width: 26, height: 26, flexShrink: 0 })} />
            <div style={styles.skeletonLines}>
              <span style={block({ width: `${52 - i * 8}%`, height: 11 })} />
              <span style={block({ width: `${34 - i * 5}%`, height: 9 })} />
            </div>
            <span style={block({ width: 56, height: 18, borderRadius: 999, flexShrink: 0 })} />
          </div>
        );
      })}
    </>
  );
}

const skeletonCss = `
@keyframes wa-pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.4 } }
`;

// --- Panel superior: idle ---

function NewRecordingPanel({
  deviceOnline,
  wsStatus,
  pending,
  uploading,
  uploadPercent,
  pendingUploads,
  error,
  onStart,
}: {
  deviceOnline: boolean | null;
  wsStatus: WsStatus;
  pending: boolean;
  uploading: boolean;
  uploadPercent: number | null;
  pendingUploads: number;
  error: string | null;
  onStart: () => void;
}) {
  const compact = useCompact();
  const [hovered, setHovered] = useState(false);
  // Mientras sube, la SD está ocupada y la ESP32 rechazaría el start: mejor no
  // ofrecerlo. Que queden ficheros pendientes no estorba, esos se suben solos.
  const disabled = wsStatus !== "connected" || deviceOnline !== true || pending || uploading;
  const hover = hovered && !disabled;

  return (
    <div style={{ ...styles.idlePanel, ...(compact ? mobile.idlePanel : null) }}>
      <div style={styles.idleInfo}>
        <ConnectionBadge wsStatus={wsStatus} deviceOnline={deviceOnline} />
        {error != null ? (
          <p style={styles.errorHint}>{error}</p>
        ) : (
          <p style={styles.idleHint}>
            {wsStatus !== "connected"
              ? "Esperando conexión con el servidor…"
              : deviceOnline !== true
                ? "Tu ESP32 no está conectada."
                : uploading
                  ? "Subiendo la última grabación…"
                  : pendingUploads > 0
                    ? `${pendingUploads} grabación(es) esperando a subirse.`
                    : "Pulsa para empezar a registrar la señal respiratoria."}
          </p>
        )}
        {uploading && <UploadBar percent={uploadPercent} />}
      </div>
      <button
        onClick={onStart}
        disabled={disabled}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          ...styles.newButton,
          ...(compact ? mobile.newButton : null),
          border: hover ? `3px solid ${ACCENT}` : `3px solid ${INK}`,
          boxShadow: hover ? `6px 6px 0 ${ACCENT}` : `6px 6px 0 ${INK}`,
          transform: hover ? "translate(-2px, -2px)" : "none",
          opacity: disabled ? 0.4 : 1,
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      >
        <PlusIcon />
        Nueva Grabación
      </button>
    </div>
  );
}

// Cuánto del fichero ha llegado al server. El número lo mide server2 contra el
// Content-Length del POST (la ESP32 manda el .bin de una pieza, así que el total
// se sabe desde el primer byte); aquí solo se pinta.
//
// Sin número todavía, la barra sale vacía con "…" en vez de rellenarse sola:
// una barra que se mueve sin saber nada miente más que no decir nada.
function UploadBar({ percent }: { percent: number | null }) {
  return (
    <div style={styles.uploadBar}>
      <div style={styles.uploadTrack}>
        <div style={{ ...styles.uploadFill, width: `${percent ?? 0}%` }} />
      </div>
      <span style={styles.uploadPercent}>{percent == null ? "…" : `${percent}%`}</span>
    </div>
  );
}

// --- Panel superior: grabando ---
//
// Solo se ve mientras el status diga que hay grabación. En cuanto para, la SD
// pasa a subir y el panel vuelve a ser el de "nueva grabación": no hay fila que
// enseñar hasta que el fichero llegue al server.

function RecordingNowPanel({
  startedEpochMs,
  elapsedSeconds,
  deviceOnline,
  wsStatus,
  pending,
  error,
  onStop,
}: {
  startedEpochMs: number;
  elapsedSeconds: number;
  deviceOnline: boolean | null;
  wsStatus: WsStatus;
  pending: boolean;
  error: string | null;
  onStop: () => void;
}) {
  const compact = useCompact();

  return (
    <div style={{ ...styles.livePanel, ...(compact ? mobile.livePanel : null) }}>
      <div style={styles.liveHeaderRow}>
        <div style={styles.liveTitleGroup}>
          <span style={styles.recDot} />
          <span style={styles.liveTitle}>Recording Now</span>
        </div>
        <span style={styles.liveConnText}>
          {wsStatus !== "connected"
            ? "Reconectando…"
            : deviceOnline !== true
              ? "ESP32 desconectada"
              : "ESP32 Conectada · Grabando…"}
        </span>
      </div>

      <div style={styles.liveMetrics}>
        <div style={{ ...styles.liveMetric, ...(compact ? mobile.liveMetric : null) }}>
          <div style={styles.metricLabel}>Started</div>
          <div style={{ ...styles.metricValueLg, ...(compact ? mobile.metricValueLg : null) }}>
            {formatTime(new Date(startedEpochMs))}
          </div>
        </div>
        <div style={{ ...styles.liveMetric, ...(compact ? mobile.liveMetric : null) }}>
          <div style={styles.metricLabel}>Duration</div>
          <div style={{ ...styles.metricValueLg, ...(compact ? mobile.metricValueLg : null) }}>
            {formatClock(elapsedSeconds)}
          </div>
        </div>
        <div style={{ ...styles.liveMetric, ...(compact ? mobile.liveMetric : null) }}>
          <div style={styles.metricLabel}>Nombre</div>
          <div style={{ ...styles.metricValueSm, ...(compact ? mobile.metricValueSm : null) }}>
            {recordingName(startedEpochMs)}
          </div>
        </div>
      </div>

      <div style={styles.liveActions}>
        <Link
          href="/realtime"
          style={{
            ...styles.actionBtn,
            ...styles.actionBtnGhost,
            ...(compact ? mobile.actionBtn : null),
          }}
        >
          Live View
        </Link>
        <button
          onClick={onStop}
          disabled={pending}
          style={{
            ...styles.actionBtn,
            ...styles.actionBtnStop,
            ...(compact ? mobile.actionBtn : null),
            opacity: pending ? 0.6 : 1,
          }}
        >
          {pending ? "Parando…" : "Stop"}
        </button>
        {error != null && <span style={styles.errorInline}>{error}</span>}
      </div>
    </div>
  );
}

// --- Botón pequeño, de la cabecera de la lista y de las filas ---

function SmallButton({
  label,
  onClick,
  danger = false,
  disabled = false,
}: {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...styles.smallButton,
        ...(danger ? styles.smallButtonDanger : null),
        opacity: disabled ? 0.35 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

// --- Fila de grabación ---
//
// Tres estados: en reposo la fila es un enlace a la grabación; con el menú
// abierto cambia el lado derecho por sus dos acciones; renombrando, el nombre
// pasa a ser un campo de texto. Las acciones nunca van dentro del enlace (ni
// menús flotantes, que la lista tiene scroll propio y los recortaría).
type RowAction = "menu" | "rename";

function RecordingRow({
  recording,
  selecting,
  selected,
  action,
  onAction,
  onToggle,
  onDelete,
  onRenamed,
}: {
  recording: Recording;
  selecting: boolean;
  selected: boolean;
  action: RowAction | null;
  onAction: (kind: RowAction | null) => void;
  onToggle: () => void;
  onDelete: () => void;
  onRenamed: () => void;
}) {
  const compact = useCompact();
  const [hover, setHover] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const menuOpen = !selecting && action === "menu";
  const renaming = !selecting && action === "rename";

  const date = new Date(recording.started_at);
  // Sin uploaded_at la fila existe pero su binario no llegó a Storage: la ESP32
  // lo sigue reintentando, así que se marca en vez de enseñar una duración que
  // todavía no se puede abrir.
  const seconds = recording.uploaded_at === null
    ? null
    : durationSeconds(recording.started_at, recording.ended_at);
  const name = displayName(recording);

  const startRename = () => {
    setDraft(name);
    setError(null);
    onAction("rename");
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      // En blanco = quitarle el nombre propio y volver al derivado del inicio.
      await renameRecording(recording.uuid, draft);
      onAction(null);
      onRenamed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const label = (
    <>
      <span style={styles.rowName}>{name}</span>
      <span style={{ ...styles.rowMeta, ...(compact ? mobile.rowMeta : null) }}>
        {recording.username} · {formatRelativeDate(date)} · {formatTime(date)}
      </span>
    </>
  );

  return (
    <div
      style={{
        ...styles.row,
        background: selected
          ? "rgba(0,224,168,0.16)"
          : hover && !selecting
            ? "rgba(0,224,168,0.08)"
            : "transparent",
        borderLeft: selected || (hover && !selecting) ? `2px solid ${ACCENT}` : "2px solid transparent",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {selecting ? (
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={selected}
          title="Seleccionar"
          style={{ ...styles.checkbox, background: selected ? ACCENT : PAPER }}
        >
          {selected && <CheckIcon />}
        </button>
      ) : (
        <div style={styles.rowIcon}>
          <WaveIcon />
        </div>
      )}

      {renaming ? (
        <div style={styles.renameBox}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") onAction(null);
            }}
            maxLength={80}
            placeholder={recordingName(recording.started_at)}
            spellCheck={false}
            style={styles.renameInput}
          />
          {error != null && <span style={styles.rowError}>{error}</span>}
        </div>
      ) : selecting ? (
        <button
          type="button"
          onClick={onToggle}
          style={{ ...styles.rowMain, ...(compact ? mobile.rowMain : null) }}
        >
          {label}
        </button>
      ) : (
        <Link
          href={`/recordings/${recording.uuid}`}
          style={{ ...styles.rowMain, ...(compact ? mobile.rowMain : null) }}
        >
          {label}
        </Link>
      )}

      {renaming ? (
        <>
          <SmallButton label={saving ? "…" : "Guardar"} onClick={save} disabled={saving} />
          <SmallButton label="Cancelar" onClick={() => onAction(null)} disabled={saving} />
        </>
      ) : (
        <>
          <span style={styles.rowDuration}>
            {seconds == null ? "Sin subir" : formatClock(seconds)}
          </span>
          {!selecting &&
            (menuOpen ? (
              <>
                <SmallButton label="Renombrar" onClick={startRename} />
                <SmallButton label="Borrar" danger onClick={onDelete} />
                <SmallButton label="✕" onClick={() => onAction(null)} />
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => onAction("menu")}
                  title="Acciones"
                  aria-label="Acciones de la grabación"
                  style={styles.rowMenuButton}
                >
                  ⋯
                </button>
                <ChevronIcon />
              </>
            ))}
        </>
      )}
    </div>
  );
}

function ConnectionBadge({ wsStatus, deviceOnline }: { wsStatus: WsStatus; deviceOnline: boolean | null }) {
  const config = (() => {
    if (wsStatus !== "connected") {
      return {
        connecting: { color: "#ca8a04", text: "Conectando" },
        disconnected: { color: "#dc2626", text: "Desconectado" },
        error: { color: "#dc2626", text: "Error de red" },
      }[wsStatus as "connecting" | "disconnected" | "error"];
    }
    return deviceOnline ? { color: "#00e0a8", text: "ESP32 Conectada" } : { color: "#dc2626", text: "ESP32 Desconectada" };
  })();

  return (
    <div style={{ ...styles.badge, background: config.color }}>
      <span style={styles.badgeDot} />
      {config.text}
    </div>
  );
}

// --- Iconos ---

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <path d="M12 4v16M4 12h16" stroke={INK} strokeWidth="3" strokeLinecap="square" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path
        d="M2 12h3l2-6 4 12 3-9 2 5h6"
        stroke="#999"
        strokeWidth="2"
        strokeLinecap="square"
        strokeLinejoin="miter"
      />
    </svg>
  );
}

function ArchiveIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <rect x="3" y="5" width="13" height="14" stroke={INK} strokeWidth="2" />
      <path d="M16.5 10 21 7.5v9L16.5 14" stroke={INK} strokeWidth="2" strokeLinejoin="miter" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
      <path d="M4 12.5l5 5L20 6.5" stroke={INK} strokeWidth="3.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path d="M9 5l7 7-7 7" stroke="#aaa" strokeWidth="2.5" strokeLinecap="square" strokeLinejoin="miter" />
    </svg>
  );
}

// --- Estilos: brutalista — bordes gruesos, sombra dura, sin curvas ---
const styles: Record<string, CSSProperties> = {
  // El scroll vive aquí y no en el contenedor de la app (que está en overflow
  // hidden para el resto de páginas): así el historial puede crecer por debajo de
  // la ventana sin tocar el shell ni las demás vistas.
  main: {
    fontFamily: "'Helvetica Neue', Arial, sans-serif",
    height: "100%",
    width: "100%",
    boxSizing: "border-box",
    padding: "28px 48px 52px",
    background: PAPER,
    color: INK,
    display: "flex",
    flexDirection: "column",
    gap: 18,
    overflowY: "auto",
    overflowX: "hidden",
  },
  header: {
    borderBottom: `2px solid ${INK}`,
    paddingBottom: 14,
    flexShrink: 0,
  },
  title: {
    fontSize: 26,
    fontWeight: 900,
    letterSpacing: "-0.02em",
    textTransform: "uppercase",
    margin: 0,
  },
  subtitle: {
    fontFamily: MONO,
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#555",
    margin: "4px 0 0 0",
  },
  split: {
    flex: "none",
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  topPane: {
    flex: "none",
    display: "flex",
  },
  // Sin alto fijo: lo que manda ahora es el historial, y crece con las filas que
  // haya en vez de quedarse en una franja con scroll propio.
  bottomPane: {
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    background: "#ffffff",
    border: `2px solid ${INK}`,
    boxShadow: `6px 6px 0 ${INK}`,
    padding: "18px 24px 10px",
  },

  // Panel de arriba: una banda, no media pantalla. Antes se llevaba el hueco
  // sobrante de la ventana para enseñar un botón centrado.
  idlePanel: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 20,
    background: "#ffffff",
    border: `3px dashed ${INK}`,
    padding: "24px 28px",
  },
  idleInfo: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: 10,
    minWidth: 0,
  },
  newButton: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: ACCENT,
    color: INK,
    padding: "16px 28px",
    fontFamily: MONO,
    fontSize: 14,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    transition: "box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease",
  },
  idleHint: {
    fontFamily: MONO,
    fontSize: 11,
    color: "#666",
    margin: 0,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  errorHint: {
    fontFamily: MONO,
    fontSize: 11,
    color: "#dc2626",
    fontWeight: 700,
    margin: 0,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    maxWidth: 420,
  },
  errorInline: {
    alignSelf: "center",
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    color: "#dc2626",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  badge: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "8px 14px",
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: INK,
  },
  badgeDot: { width: 8, height: 8, background: INK, borderRadius: "50%" },

  // Barra de subida: se cuela bajo el texto del panel de reposo, sin cambiarle
  // el alto (la ESP32 no puede grabar mientras sube, así que este panel es el
  // único sitio donde puede aparecer).
  uploadBar: {
    alignSelf: "stretch",
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 240,
    maxWidth: 420,
  },
  uploadTrack: {
    flex: 1,
    height: 12,
    background: PAPER,
    border: `2px solid ${INK}`,
    overflow: "hidden",
  },
  uploadFill: { height: "100%", background: ACCENT, transition: "width 0.25s ease" },
  // Ancho mínimo: al pasar de 9% a 10% la barra no da un salto de sitio.
  uploadPercent: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 800,
    color: INK,
    minWidth: 38,
    textAlign: "right",
  },

  // live panel
  livePanel: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    gap: 22,
    background: "#ffffff",
    border: `3px solid ${INK}`,
    boxShadow: `8px 8px 0 ${INK}`,
    padding: "28px 32px",
  },
  liveHeaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 10,
  },
  liveTitleGroup: { display: "flex", alignItems: "center", gap: 10 },
  recDot: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: "#dc2626",
    boxShadow: "0 0 0 4px rgba(220,38,38,0.18)",
  },
  liveTitle: {
    fontFamily: MONO,
    fontSize: 16,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  liveConnText: {
    fontFamily: MONO,
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    color: "#555",
  },
  liveMetrics: { display: "flex", gap: 14, flexWrap: "wrap" },
  liveMetric: {
    flex: "0 0 auto",
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "10px 18px",
  },
  metricLabel: {
    fontFamily: MONO,
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    fontWeight: 700,
    color: "#555",
  },
  metricValueLg: { fontSize: 24, fontWeight: 900, marginTop: 4, fontFamily: MONO },
  metricValueSm: { fontSize: 15, fontWeight: 900, marginTop: 8, fontFamily: MONO },
  liveActions: { display: "flex", gap: 12, flexWrap: "wrap" },
  actionBtn: {
    flex: "0 0 auto",
    padding: "12px 22px",
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    border: `2px solid ${INK}`,
    boxShadow: `4px 4px 0 ${INK}`,
    textDecoration: "none",
    color: INK,
    cursor: "pointer",
  },
  actionBtnGhost: { background: PAPER },
  actionBtnStop: { background: "#dc2626", color: "#fff" },

  // list — cabecera con icono + pill de conteo, filas con acento en hover
  listHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
    flexShrink: 0,
  },
  listTitleGroup: { display: "flex", alignItems: "center", gap: 8 },
  listActions: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  listTitleIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 22,
    height: 22,
    background: ACCENT,
    border: `1.5px solid ${INK}`,
  },
  listTitle: {
    fontFamily: MONO,
    fontSize: 12,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  listCountPill: {
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 700,
    color: INK,
    background: "rgba(17,17,17,0.06)",
    border: "1px solid rgba(17,17,17,0.16)",
    borderRadius: 999,
    padding: "3px 10px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  tableHead: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 4px 8px",
    borderBottom: `2px solid ${INK}`,
    flexShrink: 0,
  },
  tableHeadIconCol: { flexShrink: 0, width: 30 },
  tableHeadCell: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: 800,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  tableHeadCellRight: {
    flexShrink: 0,
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: 800,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  // Crece con las filas, con un tope generoso para que un historial largo no
  // convierta la página en un kilómetro de scroll.
  rows: {
    flex: "none",
    maxHeight: 560,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "13px 6px 13px 4px",
    borderBottom: "1px solid rgba(17,17,17,0.08)",
    color: INK,
    transition: "background-color 0.12s ease, border-color 0.12s ease",
  },
  rowIcon: {
    flexShrink: 0,
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#888",
    background: PAPER,
    border: "1px solid rgba(17,17,17,0.16)",
  },
  // Vale igual para el <Link> de reposo y para el <button> del modo selección:
  // las dos variantes son la misma fila, solo cambia adónde lleva el clic.
  rowMain: {
    display: "flex",
    flexDirection: "row",
    alignItems: "baseline",
    gap: 8,
    minWidth: 0,
    flex: 1,
    background: "transparent",
    border: "none",
    padding: 0,
    textAlign: "left",
    textDecoration: "none",
    color: INK,
    cursor: "pointer",
  },
  rowName: {
    fontFamily: MONO,
    fontSize: 11.5,
    fontWeight: 700,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  rowMeta: {
    fontFamily: MONO,
    fontSize: 10,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.03em",
    whiteSpace: "nowrap",
  },
  rowDuration: {
    fontFamily: MONO,
    fontSize: 10.5,
    fontWeight: 800,
    color: INK,
    background: "rgba(17,17,17,0.05)",
    border: "1px solid rgba(17,17,17,0.14)",
    borderRadius: 999,
    padding: "3px 10px",
    flexShrink: 0,
  },

  // Misma caja que `row`, sin nada que dependa del ratón: no hay adónde ir.
  skeletonRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "13px 6px 13px 4px",
    borderBottom: "1px solid rgba(17,17,17,0.08)",
    borderLeft: "2px solid transparent",
  },
  skeletonLines: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 },
  skeletonBlock: {
    display: "block",
    background: "rgba(17,17,17,0.1)",
    animation: "wa-pulse 1.2s ease-in-out infinite",
  },

  // --- Selección, renombrado y borrado ---
  smallButton: {
    flexShrink: 0,
    fontFamily: MONO,
    fontSize: 10,
    fontWeight: 800,
    color: INK,
    background: PAPER,
    border: `1.5px solid ${INK}`,
    padding: "5px 10px",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    cursor: "pointer",
  },
  smallButtonDanger: { background: "#dc2626", color: "#fff" },
  checkbox: {
    flexShrink: 0,
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: `2px solid ${INK}`,
    padding: 0,
    cursor: "pointer",
  },
  renameBox: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
  renameInput: {
    width: "100%",
    boxSizing: "border-box",
    fontFamily: MONO,
    fontSize: 11.5,
    fontWeight: 700,
    color: INK,
    background: "#ffffff",
    border: `2px solid ${INK}`,
    padding: "5px 8px",
  },
  rowError: { fontFamily: MONO, fontSize: 10, fontWeight: 700, color: "#dc2626" },
  rowMenuButton: {
    flexShrink: 0,
    width: 26,
    height: 26,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "transparent",
    border: "1px solid rgba(17,17,17,0.16)",
    padding: 0,
    fontFamily: MONO,
    fontSize: 14,
    fontWeight: 900,
    lineHeight: 1,
    color: "#666",
    cursor: "pointer",
  },

  empty: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    fontFamily: MONO,
    fontSize: 11,
    color: "#888",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    padding: "16px 4px",
  },
  emptyIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    border: "2px dashed rgba(17,17,17,0.3)",
  },
};

// --- Móvil: nada de alturas fijas ni de dos paneles repartiéndose la pantalla;
// la página entera hace scroll y el historial crece hacia abajo. ---
const mobile: Record<string, CSSProperties> = {
  // Aquí el scroll lo hace el contenedor de la app (ver globals.css), así que la
  // página vuelve a crecer con su contenido y no se desplaza por dentro.
  main: {
    height: "auto",
    minHeight: "100%",
    overflowY: "visible",
    overflowX: "visible",
    padding: "16px 14px 22px",
    gap: 14,
  },
  title: { fontSize: 20 },
  split: { gap: 14 },
  bottomPane: {
    boxShadow: `4px 4px 0 ${INK}`,
    padding: "14px 14px 4px",
  },
  rows: { maxHeight: "none", overflowY: "visible" },

  idlePanel: { flexDirection: "column", alignItems: "stretch", padding: "18px 16px", gap: 14 },
  newButton: { padding: "14px 20px", fontSize: 13, justifyContent: "center" },

  livePanel: { padding: "18px 16px", gap: 16, boxShadow: `5px 5px 0 ${INK}` },
  liveMetric: { flex: "1 1 130px", padding: "8px 12px" },
  metricValueLg: { fontSize: 19 },
  metricValueSm: { fontSize: 13, marginTop: 6 },
  actionBtn: { flex: "1 1 140px", padding: "13px 14px", textAlign: "center" },

  rowMain: { flexDirection: "column", alignItems: "flex-start", gap: 2 },
  rowMeta: { whiteSpace: "normal" },
};
