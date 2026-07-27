import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("watchair")

app = FastAPI()

RECORDINGS_DIR = Path("recordings")
RECORDINGS_DIR.mkdir(exist_ok=True)


class Recorder:
    def __init__(self):
        self.file = None
        self.path: Path | None = None
        self.samples = 0

    @property
    def active(self) -> bool:
        return self.file is not None

    def start(self) -> str:
        name = datetime.now().strftime("rec_%Y%m%d_%H%M%S.csv")
        self.path = RECORDINGS_DIR / name
        self.file = open(self.path, "w", buffering=1)  # line-buffered
        self.file.write("t_ms,p\n")
        self.samples = 0
        log.info("Recording started: %s", name)
        return name

    def stop(self) -> str:
        name = self.path.name
        self.file.close()
        self.file = None
        log.info("Recording stopped: %s (%d samples)", name, self.samples)
        return name

    def write(self, raw: str):
        """Extrae t y p del JSON del ESP32 y escribe una línea CSV."""
        if not self.active:
            return
        try:
            d = json.loads(raw)
            self.file.write(f"{d['t']},{d['p']}\n")
            self.samples += 1
        except (json.JSONDecodeError, KeyError):
            pass  # mensajes de estado ({"state":...}) o basura: se ignoran


class ConnectionManager:
    def __init__(self):
        self.esp32: WebSocket | None = None
        self.frontends: set[WebSocket] = set()

    # -------------------------
    # ESP32
    # -------------------------
    async def connect_sensor(self, ws: WebSocket):
        await ws.accept()
        if self.esp32 is not None:
            try:
                await self.esp32.close()
            except Exception:
                pass
        self.esp32 = ws
        log.info("ESP32 connected")

    def disconnect_sensor(self, ws: WebSocket):
        if self.esp32 is ws:
            self.esp32 = None
            log.info("ESP32 disconnected")

    # -------------------------
    # Frontends
    # -------------------------
    async def connect_frontend(self, ws: WebSocket):
        await ws.accept()
        self.frontends.add(ws)
        log.info("Frontend connected (%d total)", len(self.frontends))

    def disconnect_frontend(self, ws: WebSocket):
        self.frontends.discard(ws)
        log.info("Frontend disconnected (%d total)", len(self.frontends))

    # -------------------------
    # Mensajes
    # -------------------------
    async def send_to_sensor(self, message: str):
        if self.esp32 is None:
            raise HTTPException(status_code=503, detail="ESP32 not connected")
        try:
            await self.esp32.send_text(message)
        except Exception:
            self.esp32 = None
            raise HTTPException(status_code=503, detail="ESP32 send failed")

    async def broadcast_frontends(self, message: str):
        if not self.frontends:
            return
        results = await asyncio.gather(
            *(ws.send_text(message) for ws in self.frontends),
            return_exceptions=True,
        )
        for ws, result in zip(list(self.frontends), results):
            if isinstance(result, Exception):
                self.frontends.discard(ws)


manager = ConnectionManager()
recorder = Recorder()


# ===================================================
# HTTP: estado y comandos
# ===================================================
@app.get("/")
async def health():
    return {
        "status": "ok",
        "esp32_connected": manager.esp32 is not None,
        "frontends_connected": len(manager.frontends),
        "recording": recorder.active,
        "recording_file": recorder.path.name if recorder.active else None,
    }


@app.post("/sensor/start")
async def sensor_start():
    await manager.send_to_sensor(json.dumps({"action": "start"}))
    return {"ok": True}


@app.post("/sensor/stop")
async def sensor_stop():
    if recorder.active:
        raise HTTPException(status_code=409, detail="Recording in progress")
    await manager.send_to_sensor(json.dumps({"action": "stop"}))
    return {"ok": True}


@app.post("/recording/start")
async def recording_start():
    if recorder.active:
        raise HTTPException(status_code=409, detail="Already recording")
    await manager.send_to_sensor(json.dumps({"action": "start"}))  # grabar implica medir
    name = recorder.start()
    await manager.broadcast_frontends(json.dumps({"rec": True, "file": name}))
    return {"ok": True, "file": name}


@app.post("/recording/stop")
async def recording_stop():
    if not recorder.active:
        raise HTTPException(status_code=409, detail="Not recording")
    name = recorder.stop()
    await manager.send_to_sensor(json.dumps({"action": "stop"}))
    await manager.broadcast_frontends(json.dumps({"rec": False, "file": name}))
    return {"ok": True, "file": name}


@app.get("/recordings")
async def list_recordings():
    files = sorted(RECORDINGS_DIR.glob("*.csv"), reverse=True)
    return [
        {"file": f.name, "size_bytes": f.stat().st_size}
        for f in files
    ]


# ===================================================
# WS ESP32: entrada de datos
# ===================================================
@app.websocket("/sensor")
async def sensor(ws: WebSocket):
    await manager.connect_sensor(ws)
    try:
        while True:
            message = await ws.receive_text()
            await manager.broadcast_frontends(message)  # live siempre
            recorder.write(message)                     # a fichero solo si grabando
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect_sensor(ws)


# ===================================================
# WS Frontend: solo escucha, conectarse = recibir
# ===================================================
@app.websocket("/frontend")
async def frontend(ws: WebSocket):
    await manager.connect_frontend(ws)
    try:
        while True:
            await ws.receive_text()  # ignora lo que llegue; mantiene viva la conexión
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect_frontend(ws)