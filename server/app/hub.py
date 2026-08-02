import asyncio
import logging
import time
from pathlib import Path

from fastapi import WebSocket

from . import config

log = logging.getLogger("watchair.hub")


class Device:
    """Una ESP32 conectada. La ESP32 es la fuente de verdad: aqui solo se
    refleja lo que reporta, nunca se decide por ella."""

    def __init__(self, uuid: str, ws: WebSocket):
        self.uuid = uuid
        self.ws = ws
        self.last_seen = time.monotonic()
        self.broadcasting = False  # lo ultimo que dijo su heartbeat
        self.recording_uuid: str | None = None
        self.upload: tuple[str, Path] | None = None  # (uuid de grabacion, fichero parcial)
        self.ack: asyncio.Future | None = None  # start en vuelo, lo resuelve el recording_ack
        self.ack_uuid: str | None = None
        self.mismatch_since: float | None = None  # desde cuando difieren deseado y reportado

    async def send(self, message: dict) -> bool:
        try:
            await self.ws.send_json(message)
            return True
        except Exception:
            return False


# Estado en memoria; no se persiste nada. Al reiniciar server2, cada ESP32
# reconstruye lo suyo con el `hello` en cuanto reconecta.
devices: dict[str, Device] = {}
subscribers: dict[str, set[WebSocket]] = {}


async def notify(uuid: str, message: dict):
    """Empuja a los browsers que miran ese aparato."""
    subs = subscribers.get(uuid)
    if not subs:
        return
    for ws in list(subs):
        try:
            await ws.send_json(message)
        except Exception:
            subs.discard(ws)


async def reconcile_tick():
    """Cada segundo: caduca los aparatos sin heartbeat y reenvia los comandos
    de emision que se hayan perdido."""
    now = time.monotonic()
    for uuid, dev in list(devices.items()):
        if now - dev.last_seen > config.ONLINE_TIMEOUT_S:
            log.warning("Device %s sin heartbeat: se marca offline", uuid)
            if devices.get(uuid) is dev:
                del devices[uuid]
            await dev.ws.close()
            await notify(uuid, {"type": "device_offline", "uuid": uuid})
            continue

        desired = bool(subscribers.get(uuid))
        if desired == dev.broadcasting:
            dev.mismatch_since = None
        elif dev.mismatch_since is None:
            dev.mismatch_since = now
        elif now - dev.mismatch_since >= config.RECONCILE_GRACE_S:
            cmd = "start_broadcast" if desired else "stop_broadcast"
            log.info("Device %s: comando de emision perdido, reenvio %s", uuid, cmd)
            await dev.send({"type": cmd})
            dev.mismatch_since = now  # no reenviar en cada tick
