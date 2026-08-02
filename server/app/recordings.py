import asyncio
import logging
import uuid as uuid_lib
from datetime import datetime, timezone

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


def device_status(dev: hub.Device) -> dict:
    """Lo que esta haciendo el aparato ahora mismo, para los browsers."""
    return {
        "type": "device_status",
        "uuid": dev.uuid,
        "recording": bool(dev.recording_now),
        "uploading": bool(dev.uploading),
    }


async def reconcile_heartbeat(dev: hub.Device, recording: bool, uploading: bool):
    """El heartbeat (cada 2 s) es la unica fuente continua de estado: el hello
    solo cuenta lo que pasa al reconectar.

    Sin esto, un server2 reiniciado a mitad de una subida no tiene forma de
    saberlo, y la UI enseña "grabando" con el cronometro corriendo para algo que
    en realidad ya paró y se esta subiendo. Solo se avisa cuando algo cambia,
    no en cada latido.
    """
    if dev.recording_now == recording and dev.uploading == uploading:
        return
    dev.recording_now = recording
    dev.uploading = uploading
    await hub.notify(dev.uuid, device_status(dev))


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


# --- subida: un POST con el fichero entero ----------------------------------

async def complete_upload(device_uuid: str, rec_uuid: str, data: bytes):
    """Persiste el .bin que acaba de subir la ESP32 por POST.

    No hay reanudacion ni checksum a proposito: el fichero cabe de sobra en una
    peticion (12 h a 25 Hz ≈ 6,5 MB) y la ESP32 no borra su copia de la SD hasta
    ver un 200. Si esto falla, se responde !=200 y la ESP32 reintenta entera mas
    tarde; no se pierde nada.
    """
    await asyncio.to_thread(db.complete_recording, rec_uuid, device_uuid, data)

    dev = hub.devices.get(device_uuid)
    if dev is not None and dev.recording_uuid == rec_uuid:
        dev.recording_uuid = None
    await hub.notify(device_uuid, {"type": "recording_finished", "uuid": rec_uuid})
    log.info("Upload %s: %d B persistidos en Supabase", rec_uuid, len(data))
