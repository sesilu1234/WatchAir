import asyncio
import logging
import time

from fastapi import WebSocket

from . import config

log = logging.getLogger("watchair.hub")


class Device:
    """Una ESP32 conectada. La ESP32 es la fuente de verdad: aqui solo se
    refleja lo que dice su `status`, nunca se decide por ella ni se lleva
    contabilidad propia."""

    def __init__(self, uuid: str, ws: WebSocket):
        self.uuid = uuid
        self.ws = ws
        self.last_seen = time.monotonic()

        # Espejo del ultimo `status`. Lo escribe una sola linea, la que procesa
        # ese mensaje (ver recordings.on_status). `rec_uuid` no es None <=> hay
        # grabacion en curso: no hay un flag aparte que pueda contradecirlo.
        self.rec_uuid: str | None = None
        self.rec_started_epoch_ms: int | None = None
        self.broadcasting = False
        self.uploading = False
        self.pending = 0

        # Un comando (start o stop) en vuelo. Lo resuelve el `status` que
        # confirma el cambio, o un `nack` si la ESP32 no pudo.
        self.ack: asyncio.Future | None = None
        self.ack_target: str | None = None  # el rec_uuid que esperamos ver (None = parada)
        # Serializa start y stop del mismo aparato: sin esto, un segundo POST
        # pisa `ack` y deja al primero esperando un future que ya nadie resuelve.
        self.command_lock = asyncio.Lock()

        self.mismatch_since: float | None = None  # desde cuando difieren deseado y reportado

    async def send(self, message: dict) -> bool:
        try:
            await self.ws.send_json(message)
            return True
        except Exception:
            return False


# Estado en memoria; no se persiste nada. Al reiniciar server2, cada ESP32
# reconstruye lo suyo con el `status` en cuanto reconecta.
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


async def expire_offline():
    """Caduca los aparatos que llevan demasiado sin mandar un `status`."""
    now = time.monotonic()
    for uuid, dev in list(devices.items()):
        if now - dev.last_seen <= config.ONLINE_TIMEOUT_S:
            continue
        log.warning("Device %s sin status: se marca offline", uuid)
        if devices.get(uuid) is dev:
            del devices[uuid]
        await dev.ws.close()
        await notify(uuid, {"type": "device_offline", "uuid": uuid})


async def reconcile_broadcast():
    """Reenvia el comando de emision que se haya perdido. Es la unica
    reconciliacion que queda: la grabacion la confirma el NACK/status del
    comando, asi que ahi no hay nada que reconciliar."""
    now = time.monotonic()
    for uuid, dev in list(devices.items()):
        desired = bool(subscribers.get(uuid))  # >=1 browser mirando => hay que emitir
        if desired == dev.broadcasting:
            dev.mismatch_since = None
        elif dev.mismatch_since is None:
            dev.mismatch_since = now
        elif now - dev.mismatch_since >= config.RECONCILE_GRACE_S:
            cmd = "start_broadcast" if desired else "stop_broadcast"
            log.info("Device %s: comando de emision perdido, reenvio %s", uuid, cmd)
            await dev.send({"type": cmd})
            dev.mismatch_since = now  # no reenviar en cada tick
