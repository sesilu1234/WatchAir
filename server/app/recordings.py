import asyncio
import logging
import uuid as uuid_lib
import zlib
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from . import config, db, hub
from .auth import BrowserClaims

log = logging.getLogger("watchair.recordings")


async def _announce_started(dev: hub.Device, rec_uuid: str) -> dict:
    """Crea la fila y avisa a los browsers. Devuelve la fila.

    La fila se escribe en segundo plano: que tarde en aparecer en la lista no
    bloquea al browser, y el fichero vive en la SD del ESP32 pase lo que pase.
    """
    started_at = datetime.now(timezone.utc).isoformat()
    row = {"uuid": rec_uuid, "device_uuid": dev.uuid, "started_at": started_at, "ended_at": None}

    async def write():
        try:
            await asyncio.to_thread(db.insert_recording, rec_uuid, dev.uuid, started_at)
        except Exception:
            log.exception("No se pudo crear la fila de %s", rec_uuid)

    asyncio.create_task(write())
    await hub.notify(dev.uuid, {"type": "recording_started", "recording": row})
    return row


# --- control desde el navegador ---------------------------------------------

async def start(claims: BrowserClaims) -> dict:
    """La fila nace del ACK del ESP32, no del clic: sin ACK no hay grabacion."""
    dev = hub.devices.get(claims.device_uuid)
    if dev is None:
        raise HTTPException(status_code=503, detail="ESP32 no conectada")
    if dev.recording_uuid is not None:
        raise HTTPException(status_code=409, detail="Grabación en curso, pare antes la actual")

    rec_uuid = str(uuid_lib.uuid4())
    dev.ack = asyncio.get_running_loop().create_future()
    dev.ack_uuid = rec_uuid
    try:
        if not await dev.send({"type": "start_recording", "uuid": rec_uuid}):
            raise HTTPException(status_code=503, detail="ESP32 no conectada")
        try:
            ok, reason = await asyncio.wait_for(dev.ack, timeout=config.ACK_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="La ESP32 no confirmó a tiempo")
        if not ok:
            raise HTTPException(status_code=409, detail=f"La ESP32 no pudo grabar: {reason}")
    finally:
        dev.ack = None
        dev.ack_uuid = None

    dev.recording_uuid = rec_uuid
    log.info("Recording %s iniciada en device %s", rec_uuid, dev.uuid)
    return await _announce_started(dev, rec_uuid)


async def stop(claims: BrowserClaims) -> dict:
    """Responde en cuanto se manda el stop: el browser no espera a la subida."""
    dev = hub.devices.get(claims.device_uuid)
    if dev is None:
        raise HTTPException(status_code=503, detail="No se puede parar sin conexión con el dispositivo")
    if dev.recording_uuid is None:
        raise HTTPException(status_code=409, detail="No hay grabación en curso")

    rec_uuid = dev.recording_uuid
    await dev.send({"type": "stop_recording"})
    await hub.notify(dev.uuid, {"type": "recording_stopping", "uuid": rec_uuid})
    log.info("Recording %s: stop pedido en device %s, subiendo…", rec_uuid, dev.uuid)
    return {"uuid": rec_uuid, "device_uuid": dev.uuid, "status": "subiendo"}


async def reconcile_hello(dev: hub.Device, reported_uuid: str | None):
    """El ESP32 manda sobre si hay grabacion en curso. Si el ACK del start se
    perdio, server2 nunca creo la fila: la grabacion estaria viva en la SD pero
    invisible en la UI. Aqui se reconcilia igual que el camino feliz."""
    if reported_uuid == dev.recording_uuid:
        return
    dev.recording_uuid = reported_uuid
    if reported_uuid is None:
        return
    await _announce_started(dev, reported_uuid)
    log.info("Recording %s reconciliada desde hello en device %s", reported_uuid, dev.uuid)


# --- subida: un fichero a la vez, reanudable por offset ---------------------

def _partial_path(device_uuid: str, rec_uuid: str) -> Path:
    directory = config.UPLOAD_DIR / device_uuid
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{rec_uuid}.bin"


async def upload_start(dev: hub.Device, message: dict):
    rec_uuid, size = message.get("uuid"), message.get("size")
    if not isinstance(rec_uuid, str) or not isinstance(size, int):
        return
    path = _partial_path(dev.uuid, rec_uuid)
    dev.upload = (rec_uuid, path)
    offset = path.stat().st_size if path.exists() else 0
    log.info("Upload %s: arranca en offset %d/%d", rec_uuid, offset, size)
    await dev.send({"type": "upload_offset", "uuid": rec_uuid, "offset": offset})


async def upload_chunk(dev: hub.Device, data: bytes):
    if dev.upload is None:
        return
    with dev.upload[1].open("ab") as f:
        f.write(data)


async def upload_done(dev: hub.Device, message: dict):
    if dev.upload is None or message.get("uuid") != dev.upload[0]:
        return
    rec_uuid, path = dev.upload

    raw = path.read_bytes()
    checksum = f"{zlib.crc32(raw) & 0xFFFFFFFF:08x}"
    if len(raw) != message.get("size") or checksum != message.get("checksum"):
        log.warning(
            "Upload %s: no coincide (size %d vs %s, checksum %s vs %s) — se pide reintento",
            rec_uuid, len(raw), message.get("size"), checksum, message.get("checksum"),
        )
        await dev.send({"type": "upload_error", "uuid": rec_uuid, "reason": "checksum_mismatch"})
        return

    try:
        await asyncio.to_thread(db.complete_recording, rec_uuid, dev.uuid, raw)
    except Exception as exc:
        # el fichero se queda en disco (aqui y en la SD): no se pierde nada,
        # solo no se le dice al ESP32 que puede borrarlo todavia.
        log.exception("No se pudo persistir %s en Supabase", rec_uuid)
        await dev.send({"type": "upload_error", "uuid": rec_uuid, "reason": f"supabase: {exc}"[:120]})
        return

    await dev.send({"type": "upload_confirmed", "uuid": rec_uuid})
    path.unlink(missing_ok=True)
    dev.upload = None
    if dev.recording_uuid == rec_uuid:
        dev.recording_uuid = None
    await hub.notify(dev.uuid, {"type": "recording_finished", "uuid": rec_uuid})
    log.info("Upload %s: confirmado y persistido en Supabase", rec_uuid)
