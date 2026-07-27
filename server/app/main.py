import asyncio
import logging

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("watchair")

app = FastAPI()


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
            # había un socket viejo (reconexión): ciérralo
            try:
                await self.esp32.close()
            except Exception:
                pass
        self.esp32 = ws
        log.info("ESP32 connected")

    def disconnect_sensor(self, ws: WebSocket):
        # solo limpia si sigue siendo el socket actual
        # (evita que la desconexión del viejo pise al nuevo)
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
        if self.esp32 is not None:
            try:
                await self.esp32.send_text(message)
            except Exception:
                self.esp32 = None

    async def broadcast_frontends(self, message: str):
        if not self.frontends:
            return
        results = await asyncio.gather(
            *(ws.send_text(message) for ws in self.frontends),
            return_exceptions=True,
        )
        # limpia los que fallaron
        for ws, result in zip(list(self.frontends), results):
            if isinstance(result, Exception):
                self.frontends.discard(ws)


manager = ConnectionManager()


# ===================================================
# Salud
# ===================================================
@app.get("/")
async def health():
    return {
        "status": "ok",
        "esp32_connected": manager.esp32 is not None,
        "frontends_connected": len(manager.frontends),
    }


# ===================================================
# ESP32
# ===================================================
@app.websocket("/sensor")
async def sensor(ws: WebSocket):
    await manager.connect_sensor(ws)
    try:
        while True:
            message = await ws.receive_text()
            log.debug("ESP32: %s", message)  # DEBUG: apagado por defecto
            await manager.broadcast_frontends(message)
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect_sensor(ws)


# ===================================================
# Frontend
# ===================================================
@app.websocket("/frontend")
async def frontend(ws: WebSocket):
    await manager.connect_frontend(ws)
    try:
        while True:
            message = await ws.receive_text()
            await manager.send_to_sensor(message)
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect_frontend(ws)