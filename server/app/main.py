import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.encoders import jsonable_encoder
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("watchair")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # tighten this once you have a domain
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)
app.add_middleware(GZipMiddleware, minimum_size=1024)

RECORDINGS_DIR = Path("recordings")
RECORDINGS_DIR.mkdir(exist_ok=True)

DSN = os.environ.get(
    "WATCHAIR_DSN",
    "postgresql://watchair:sesilu1234@localhost:5432/watchair",
)

# columnas que se exponen al frontend: `path` es interno y no sale de aquí
PUBLIC_COLS = "id, client, started_at, ended_at, samples"


# ---------------- DB ----------------
def db():
    return psycopg.connect(DSN, row_factory=dict_row)


def init_db():
    with db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS recordings (
                id         UUID PRIMARY KEY,
                client     TEXT NOT NULL DEFAULT 'sesilu1234',
                path       TEXT NOT NULL,
                started_at TIMESTAMPTZ NOT NULL,
                ended_at   TIMESTAMPTZ,
                samples    INTEGER NOT NULL DEFAULT 0
            )
        """)
        # single server process: any recording left open at startup is orphaned
        cur = conn.execute(
            "UPDATE recordings SET ended_at = started_at WHERE ended_at IS NULL"
        )
        if cur.rowcount:
            log.warning("Closed %d orphaned recordings", cur.rowcount)


init_db()


# ---------------- Recorder ----------------
class Recorder:
    def __init__(self):
        self.file = None
        self.rec_id: uuid.UUID | None = None
        self.path: Path | None = None
        self.row: dict | None = None   # fila devuelta por el INSERT
        self.samples = 0

    @property
    def active(self) -> bool:
        return self.file is not None

    def snapshot(self) -> dict | None:
        """Fila de la grabación en curso, con el contador de muestras al día."""
        if not self.active:
            return None
        return {**self.row, "samples": self.samples}

    def start(self) -> dict:
        if self.active:
            return self.snapshot()

        rec_id = uuid.uuid4()
        path = RECORDINGS_DIR / f"{rec_id}.csv"
        file = open(path, "w", buffering=1)  # line-buffered
        file.write("t_ms,p\n")
        try:
            with db() as conn:
                row = conn.execute(
                    "INSERT INTO recordings (id, path, started_at) "
                    f"VALUES (%s, %s, now()) RETURNING {PUBLIC_COLS}",
                    (rec_id, str(path)),
                ).fetchone()
        except Exception:
            # sin fila en la BD la grabación no existe: no dejes el fichero suelto
            file.close()
            path.unlink(missing_ok=True)
            raise

        self.file, self.rec_id, self.path, self.row = file, rec_id, path, row
        self.samples = 0
        log.info("Recording started: %s", rec_id)
        return self.snapshot()

    def stop(self) -> dict | None:
        if not self.active:
            return None
        rec_id, samples = self.rec_id, self.samples
        self.file.close()
        self.file = None
        with db() as conn:
            row = conn.execute(
                "UPDATE recordings SET ended_at = now(), samples = %s "
                f"WHERE id = %s RETURNING {PUBLIC_COLS}",
                (samples, rec_id),
            ).fetchone()
        self.rec_id = self.path = self.row = None
        log.info("Recording stopped: %s (%d samples)", rec_id, samples)
        return row

    def write(self, sample: dict):
        if not self.active:
            return
        try:
            self.file.write(f"{sample['t']},{sample['p']}\n")
            self.samples += 1
        except KeyError:
            pass


recorder = Recorder()


# ---------------- WS connections ----------------
class ConnectionManager:
    def __init__(self):
        self.esp32: WebSocket | None = None
        self.frontends: set[WebSocket] = set()
        self.measuring = False   # último {"state": ...} reportado por el ESP32

    async def connect_sensor(self, ws: WebSocket):
        await ws.accept()
        self.esp32 = ws
        self.measuring = False   # hasta que el ESP32 diga lo contrario
        log.info("ESP32 connected")

    def disconnect_sensor(self, ws: WebSocket) -> bool:
        if self.esp32 is not ws:   # identity guard: don't clobber a newer connection
            return False
        self.esp32 = None
        self.measuring = False
        log.info("ESP32 disconnected")
        return True

    async def connect_frontend(self, ws: WebSocket):
        await ws.accept()
        self.frontends.add(ws)
        log.info("Frontend connected (%d)", len(self.frontends))

    def disconnect_frontend(self, ws: WebSocket):
        self.frontends.discard(ws)
        log.info("Frontend disconnected (%d)", len(self.frontends))

    async def send_to_sensor(self, message: str) -> bool:
        if self.esp32 is None:
            return False
        try:
            await self.esp32.send_text(message)
            return True
        except Exception:
            self.esp32 = None
            return False

    async def broadcast_frontends(self, message: str):
        if not self.frontends:
            return
        targets = list(self.frontends)
        results = await asyncio.gather(
            *(ws.send_text(message) for ws in targets),
            return_exceptions=True,
        )
        for ws, res in zip(targets, results):
            if isinstance(res, Exception):
                self.frontends.discard(ws)


manager = ConnectionManager()


async def broadcast_recording_state(recording: dict, active: bool, **extra):
    """Avisa a los frontends del cambio de estado de la grabación."""
    payload = {"rec": active, "recording": jsonable_encoder(recording), **extra}
    await manager.broadcast_frontends(json.dumps(payload))


# ===================================================
# HTTP: commands
# ===================================================
@app.post("/sensor/start")
async def sensor_start():
    ok = await manager.send_to_sensor(json.dumps({"cmd": "start"}))
    if not ok:
        raise HTTPException(status_code=503, detail="ESP32 not connected")
    return {"ok": True}


@app.post("/sensor/stop")
async def sensor_stop():
    if recorder.active:
        # don't allow stopping the sensor while a recording is in progress
        raise HTTPException(status_code=409, detail="Recording in progress")
    ok = await manager.send_to_sensor(json.dumps({"cmd": "stop"}))
    if not ok:
        raise HTTPException(status_code=503, detail="ESP32 not connected")
    return {"ok": True}


@app.post("/recording/start")
async def recording_start():
    if recorder.active:
        raise HTTPException(status_code=409, detail="Recording already in progress")
    # recording implies measuring: turn the sensor on regardless of its state
    ok = await manager.send_to_sensor(json.dumps({"cmd": "start"}))
    if not ok:
        raise HTTPException(status_code=503, detail="ESP32 not connected")
    row = recorder.start()
    await broadcast_recording_state(row, active=True)
    return row


@app.post("/recording/stop")
async def recording_stop():
    if not recorder.active:
        raise HTTPException(status_code=409, detail="No recording in progress")
    row = recorder.stop()
    await manager.send_to_sensor(json.dumps({"cmd": "stop"}))
    await broadcast_recording_state(row, active=False)
    return row


# ===================================================
# HTTP: recordings queries (for the frontend)
# ===================================================
@app.get("/status")
def status():
    return {
        "esp32_connected": manager.esp32 is not None,
        "frontends_connected": len(manager.frontends),
        "measuring": manager.measuring,
        "recording": recorder.snapshot(),   # null si no hay ninguna en curso
        # el frontend lo usa para corregir el desfase de reloj y contar bien
        # la duración de la grabación en curso
        "server_time": datetime.now(timezone.utc).isoformat(),
    }


def with_live_samples(row: dict) -> dict:
    """`samples` sólo se persiste al parar: para la grabación en curso, cuéntalo en vivo."""
    if recorder.active and row["id"] == recorder.rec_id:
        return {**row, "samples": recorder.samples}
    return row


@app.get("/recordings")
def list_recordings():
    with db() as conn:
        rows = conn.execute(
            f"SELECT {PUBLIC_COLS} FROM recordings ORDER BY started_at DESC"
        ).fetchall()
    return [with_live_samples(r) for r in rows]


def get_rec_or_404(rec_id: str, columns: str = PUBLIC_COLS) -> dict:
    try:
        rid = uuid.UUID(rec_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="Not found")
    with db() as conn:
        row = conn.execute(
            f"SELECT {columns} FROM recordings WHERE id = %s", (rid,)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Not found")
    return row


@app.get("/recordings/{rec_id}")
def recording_meta(rec_id: str):
    return with_live_samples(get_rec_or_404(rec_id))


@app.get("/recordings/{rec_id}/data")
def recording_data(rec_id: str):
    row = get_rec_or_404(rec_id, columns="id, path")
    path = Path(row["path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, media_type="text/csv", filename=f"{rec_id}.csv")


# ===================================================
# WS ESP32: data in
# ===================================================
def handle_sensor_message(raw: str):
    """Un único parseo: los {"state": ...} actualizan estado, el resto son muestras."""
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        return
    if not isinstance(d, dict):
        return
    state = d.get("state")
    if isinstance(state, str):
        manager.measuring = state == "measuring"
        return
    recorder.write(d)


@app.websocket("/sensor")
async def sensor(ws: WebSocket):
    await manager.connect_sensor(ws)
    try:
        while True:
            message = await ws.receive_text()
            await manager.broadcast_frontends(message)
            handle_sensor_message(message)
    except WebSocketDisconnect:
        pass
    finally:
        was_current = manager.disconnect_sensor(ws)
        # sin sensor no hay señal que grabar: cierra la grabación en curso en vez
        # de dejarla abierta para siempre bloqueando el resto
        if was_current and recorder.active:
            row = recorder.stop()
            log.warning("Recording %s closed: ESP32 disconnected", row["id"])
            await broadcast_recording_state(row, active=False, reason="sensor_disconnected")


# ===================================================
# WS Frontend: listen-only, connect = receive
# ===================================================
@app.websocket("/frontend")
async def frontend(ws: WebSocket):
    await manager.connect_frontend(ws)
    try:
        while True:
            await ws.receive_text()  # ignore incoming; keeps the connection alive
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect_frontend(ws)
