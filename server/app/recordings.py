import asyncio
import logging
import uuid as uuid_lib
from datetime import datetime, timezone

from fastapi import HTTPException

from . import config, internal_client
from .auth import BrowserClaims
from .devices import registry

log = logging.getLogger("watchair.recordings")


async def start_recording(claims: BrowserClaims) -> dict:
    conn = registry.get(claims.device_uuid)
    if conn is None:
        raise HTTPException(status_code=503, detail="ESP32 no conectada")
    if conn.current_recording_uuid is not None:
        raise HTTPException(status_code=409, detail="Grabación en curso, pare antes la actual")

    rec_uuid = str(uuid_lib.uuid4())
    ack = asyncio.get_running_loop().create_future()
    conn.pending_ack = ack
    conn.pending_ack_uuid = rec_uuid

    sent = await conn.send({"type": "start_recording", "uuid": rec_uuid})
    if not sent:
        conn.pending_ack = None
        conn.pending_ack_uuid = None
        raise HTTPException(status_code=503, detail="ESP32 no conectada")

    try:
        await asyncio.wait_for(ack, timeout=config.RECORDING_ACK_TIMEOUT_S)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="La ESP32 no confirmó a tiempo")
    finally:
        conn.pending_ack = None
        conn.pending_ack_uuid = None

    started_at = datetime.now(timezone.utc)
    conn.current_recording_uuid = rec_uuid

    row = {
        "uuid": rec_uuid,
        "device_uuid": claims.device_uuid,
        "started_at": started_at.isoformat(),
        "ended_at": None,
    }
    # fire-and-forget: si el frontend no responde ahora, notify_recording_started
    # reintenta solo; que tarde en persistir la fila no bloquea al browser.
    asyncio.create_task(
        internal_client.notify_recording_started(
            uuid=rec_uuid, device_uuid=claims.device_uuid, started_at=row["started_at"]
        )
    )
    await registry.broadcast_to_subscribers(
        claims.device_uuid, {"type": "recording_started", "recording": row}
    )
    log.info("Recording %s iniciada en device %s", rec_uuid, claims.device_uuid)
    return row


async def stop_recording(claims: BrowserClaims) -> dict:
    conn = registry.get(claims.device_uuid)
    if conn is None:
        raise HTTPException(status_code=503, detail="No se puede parar sin conexión con el dispositivo")
    if conn.current_recording_uuid is None:
        raise HTTPException(status_code=409, detail="No hay grabación en curso")

    rec_uuid = conn.current_recording_uuid
    await conn.send({"type": "stop_recording"})
    # server2 responde enseguida: no espera a que termine de subirse.
    await registry.broadcast_to_subscribers(
        claims.device_uuid, {"type": "recording_stopping", "uuid": rec_uuid}
    )
    log.info("Recording %s: stop pedido en device %s, subiendo…", rec_uuid, claims.device_uuid)
    return {"uuid": rec_uuid, "device_uuid": claims.device_uuid, "status": "subiendo"}


async def reconcile_from_hello(conn, reported_uuid: str | None):
    """Se llama con cada 'hello'. El ESP32 manda sobre si hay grabación en
    curso; normalmente esto solo confirma lo que server2 ya sabía. Pero si el
    ACK de start_recording se perdió (p.ej. el WS se cayó justo después de que
    el ESP32 ya hubiera arrancado a grabar en la SD), server2 nunca llegó a
    crear la fila en Supabase ni a avisar a los browsers: la grabación queda
    viva en la SD pero invisible en la UI y bloqueando cualquier start nuevo.
    Aquí se reconcilia igual que hace el camino feliz de start_recording.
    """
    if reported_uuid == conn.current_recording_uuid:
        return
    conn.current_recording_uuid = reported_uuid
    if reported_uuid is None:
        return

    started_at = datetime.now(timezone.utc).isoformat()
    row = {"uuid": reported_uuid, "device_uuid": conn.uuid, "started_at": started_at, "ended_at": None}
    asyncio.create_task(
        internal_client.notify_recording_started(
            uuid=reported_uuid, device_uuid=conn.uuid, started_at=started_at
        )
    )
    await registry.broadcast_to_subscribers(conn.uuid, {"type": "recording_started", "recording": row})
    log.info("Recording %s reconciliada desde hello en device %s", reported_uuid, conn.uuid)


def handle_ack(conn, message: dict):
    if conn.pending_ack is None or message.get("uuid") != conn.pending_ack_uuid:
        return
    if not conn.pending_ack.done():
        conn.pending_ack.set_result(True)


async def handle_recording_finished(conn, rec_uuid: str, device_uuid: str):
    """Se llama cuando la subida terminó y el frontend confirmó (ver upload.py)."""
    if conn.current_recording_uuid == rec_uuid:
        conn.current_recording_uuid = None
    await registry.broadcast_to_subscribers(device_uuid, {"type": "recording_finished", "uuid": rec_uuid})
