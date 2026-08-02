import asyncio
import logging
import time

from fastapi import WebSocket

from . import config

log = logging.getLogger("watchair.devices")


class DeviceConnection:
    def __init__(self, uuid: str, ws: WebSocket):
        self.uuid = uuid
        self.ws = ws
        self.last_seen = time.monotonic()
        self.reported_broadcasting = False
        self.reported_recording = False
        # Fuente de verdad de "hay grabación en curso": la marca el ACK del
        # ESP32 al arrancar y el hello al reconectar (gana la ESP32, nunca server2).
        self.current_recording_uuid: str | None = None
        self.pending_uploads: list[dict] = []
        self.upload = None  # UploadSession | None (ver app/upload.py; evita import circular)
        # Resuelto cuando llega el recording_ack que le corresponde.
        self.pending_ack: asyncio.Future | None = None
        self.pending_ack_uuid: str | None = None
        # Desde cuándo difieren desired vs reported_broadcasting; None si coinciden.
        self.broadcast_mismatch_since: float | None = None

    def touch(self):
        self.last_seen = time.monotonic()

    async def send(self, message: dict) -> bool:
        try:
            await self.ws.send_json(message)
            return True
        except Exception:
            return False


class Registry:
    """Estado en memoria de dispositivos conectados y browsers suscritos a
    cada uno. server2 no persiste nada: al reiniciar, cada ESP32 reconstruye
    su fila con el frame `hello` en cuanto reconecta."""

    def __init__(self):
        self.connections: dict[str, DeviceConnection] = {}
        self.subscribers: dict[str, set[WebSocket]] = {}

    # --- dispositivos ---

    def register_device(self, uuid: str, ws: WebSocket) -> DeviceConnection:
        conn = DeviceConnection(uuid, ws)
        self.connections[uuid] = conn
        log.info("Device %s conectado", uuid)
        return conn

    def unregister_device(self, uuid: str, ws: WebSocket):
        conn = self.connections.get(uuid)
        if conn is None or conn.ws is not ws:  # identity guard: no pisar una reconexión nueva
            return
        del self.connections[uuid]
        log.info("Device %s desconectado", uuid)

    def get(self, uuid: str) -> DeviceConnection | None:
        return self.connections.get(uuid)

    def is_online(self, uuid: str) -> bool:
        return uuid in self.connections

    # --- suscriptores (browsers mirando el live view de un device) ---

    def subscribe(self, uuid: str, ws: WebSocket) -> int:
        subs = self.subscribers.setdefault(uuid, set())
        subs.add(ws)
        return len(subs)

    def unsubscribe(self, uuid: str, ws: WebSocket) -> int:
        subs = self.subscribers.get(uuid)
        if subs is None:
            return 0
        subs.discard(ws)
        if not subs:
            del self.subscribers[uuid]
            return 0
        return len(subs)

    def desired_broadcasting(self, uuid: str) -> bool:
        return bool(self.subscribers.get(uuid))

    async def broadcast_to_subscribers(self, uuid: str, message: dict):
        subs = self.subscribers.get(uuid)
        if not subs:
            return
        targets = list(subs)
        results = await asyncio.gather(
            *(ws.send_json(message) for ws in targets), return_exceptions=True
        )
        for ws, res in zip(targets, results):
            if isinstance(res, Exception):
                subs.discard(ws)

    # --- reconciliación periódica: online/offline + comandos de broadcast perdidos ---

    async def reconcile_tick(self):
        now = time.monotonic()
        for uuid, conn in list(self.connections.items()):
            if now - conn.last_seen > config.ONLINE_TIMEOUT_S:
                log.warning("Device %s sin heartbeat: se marca offline", uuid)
                self.unregister_device(uuid, conn.ws)
                await conn.ws.close()
                await self.broadcast_to_subscribers(uuid, {"type": "device_offline", "uuid": uuid})
                continue

            desired = self.desired_broadcasting(uuid)
            if desired == conn.reported_broadcasting:
                conn.broadcast_mismatch_since = None
                continue

            if conn.broadcast_mismatch_since is None:
                conn.broadcast_mismatch_since = now
            elif now - conn.broadcast_mismatch_since >= config.RECONCILE_GRACE_S:
                cmd = "start_broadcast" if desired else "stop_broadcast"
                log.info("Device %s: comando de broadcast perdido, reenvío %s", uuid, cmd)
                await conn.send({"type": cmd})
                conn.broadcast_mismatch_since = now  # no reenviar cada tick


registry = Registry()
