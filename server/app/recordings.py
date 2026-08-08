import asyncio
import logging
import uuid as uuid_lib
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException

from . import config, db, hub
from .auth import BrowserClaims

log = logging.getLogger("watchair.recordings")


def device_status(dev: hub.Device) -> dict:
    """Lo unico que se le manda al browser sobre el estado del aparato: un
    espejo del ultimo `status`. El frontend no deduce nada, lo pinta tal cual.

    `recording` no viaja porque seria un duplicado: hay grabacion en curso si y
    solo si `rec_uuid` no es null.
    """
    return {
        "type": "device_status",
        "uuid": dev.uuid,
        "rec_uuid": dev.rec_uuid,
        # t=0 de la grabacion, tal como lo dice la cabecera del fichero: es lo
        # que le da nombre en la UI. Nunca un datetime.now() del server.
        "rec_started_epoch_ms": dev.rec_started_epoch_ms,
        "uploading": dev.uploading,
        "pending": dev.pending,
        # Lo pone el server, no la ESP32 (ver on_upload_progress). None = no hay
        # cuerpo entrando, o llego sin Content-Length y no hay total con el que
        # comparar: en ese caso el frontend enseña la barra sin numero en vez de
        # inventarse uno.
        "upload_percent": dev.upload_percent,
    }


# --- lo que dice la ESP32 ----------------------------------------------------


async def on_status(dev: hub.Device, data: dict):
    """El `status` (cada 2 s y ante cualquier cambio) es la unica fuente de
    estado que hay. Aqui se copia y se reparte; no se decide nada."""
    dev.rec_uuid = data.get("rec_uuid")
    dev.rec_started_epoch_ms = data.get("rec_started_epoch_ms")
    dev.broadcasting = bool(data.get("broadcasting"))
    dev.uploading = bool(data.get("uploading"))
    dev.pending = int(data.get("pending") or 0)

    await hub.notify(dev.uuid, device_status(dev))

    # Este mismo mensaje es el ACK del comando en vuelo: la ESP32 manda un
    # status en cuanto cambia de estado, asi que el start/stop se confirma en
    # cuanto se ve el rec_uuid que se pidio (o null, si lo que se pidio fue parar).
    if dev.ack is not None and not dev.ack.done() and dev.rec_uuid == dev.ack_target:
        dev.ack.set_result((True, ""))


def on_nack(dev: hub.Device, data: dict):
    """La ESP32 no pudo con el comando (sin espacio, sin NTP, subiendo, ya
    grabando…). El motivo sube tal cual al browser."""
    if dev.ack is not None and not dev.ack.done() and data.get("uuid") == dev.ack_target:
        dev.ack.set_result((False, data.get("reason") or ""))


async def on_upload_progress(dev: hub.Device | None, received: int, total: int):
    """Cuanto del .bin lleva entrado, contra el Content-Length del POST.

    Solo se avisa al browser cuando cambia el entero: un fichero de varios MB
    llega en cientos de trozos y no hace falta un mensaje por cada uno. Con eso
    la subida entera cuesta 100 mensajes como mucho, pase lo que pase.

    `dev` puede ser None si la ESP32 subio el fichero con su WS caido: entonces
    no hay estado que reflejar y la subida sigue igual, solo que sin barrita.
    """
    if dev is None or total <= 0:
        return
    percent = min(100, received * 100 // total)
    if percent == dev.upload_percent:
        return
    dev.upload_percent = percent
    await hub.notify(dev.uuid, device_status(dev))


async def clear_upload_progress(dev: hub.Device | None):
    """Se llama pase lo que pase al acabar el POST (bien, mal o a medias): la
    barra no puede quedarse clavada porque la subida se cortara."""
    if dev is None or dev.upload_percent is None:
        return
    dev.upload_percent = None
    await hub.notify(dev.uuid, device_status(dev))


# --- control desde el navegador ---------------------------------------------


async def _command(dev: hub.Device, message: dict, target: str | None):
    """Manda el comando y espera a que el estado de la ESP32 sea el pedido.

    `target` es el rec_uuid que tiene que aparecer en el status: el nuevo para
    un start, None para un stop.
    """
    dev.ack = asyncio.get_running_loop().create_future()
    dev.ack_target = target
    try:
        if not await dev.send(message):
            raise HTTPException(status_code=503, detail="ESP32 no conectada")
        try:
            ok, reason = await asyncio.wait_for(dev.ack, config.ACK_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="La ESP32 no confirmó a tiempo")
        if not ok:
            raise HTTPException(status_code=409, detail=reason)
    finally:
        dev.ack = None
        dev.ack_target = None


def _device(claims: BrowserClaims) -> hub.Device:
    dev = hub.devices.get(claims.device_uuid)
    if dev is None:
        raise HTTPException(status_code=503, detail="ESP32 no conectada")
    return dev


async def start(claims: BrowserClaims) -> dict:
    """No crea ninguna fila: la grabacion vive en la SD del aparato y la fila
    nace cuando el fichero llega al server (ver complete_upload)."""
    dev = _device(claims)
    async with dev.command_lock:
        # Dentro del lock: los starts que se quedaron esperando aqui detras se
        # cancelan solos al ver que el primero ya arranco una.
        if dev.rec_uuid is not None:
            log.info("Device %s ya está grabando %s: no se manda nada", dev.uuid, dev.rec_uuid)
            return device_status(dev)

        rec_uuid = str(uuid_lib.uuid4())
        await _command(dev, {"type": "start_recording", "uuid": rec_uuid}, rec_uuid)
        log.info("Recording %s iniciada en device %s", rec_uuid, dev.uuid)
        return device_status(dev)


async def stop(claims: BrowserClaims) -> dict:
    """Responde en cuanto la ESP32 confirma que paró: el browser no espera a la
    subida, que va por su cuenta y se ve en el `uploading` del status."""
    dev = _device(claims)
    # El mismo lock que start: un stop duplicado es inofensivo para la ESP32,
    # pero pisaria el `ack` del primero y lo dejaria colgado hasta el 504.
    async with dev.command_lock:
        if dev.rec_uuid is None:
            return device_status(dev)

        rec_uuid = dev.rec_uuid
        await _command(dev, {"type": "stop_recording"}, None)
        log.info("Recording %s parada en device %s, subiendo…", rec_uuid, dev.uuid)
        return device_status(dev)


# --- subida: un POST con el fichero entero ----------------------------------

MAGIC = b"WAIR"
HEADER_SIZE = 30  # magic(4) + version(1) + uuid(16) + hz(1) + started_epoch_ms(8 LE)
RECORD_SIZE = 6  # t_ms u32 LE + p_centiPa i16 LE
HEADER_VERSION = 3


class BadRecording(ValueError):
    """Cabecera ilegible: reintentarlo no va a arreglarlo."""


def _parse(data: bytes) -> tuple[str, datetime, datetime, int, bytes]:
    """Cabecera + cuerpo alineado. Devuelve (uuid, inicio, fin, duración, bytes).

    El fichero manda: el inicio sale de su cabecera, no de la hora del server.
    La cola sobrante se descarta siempre — un apagón a mitad de un flush deja un
    registro cortado al final, y con esta línea da igual que la ESP32 llegara a
    truncarlo o no.
    """
    if len(data) < HEADER_SIZE or data[:4] != MAGIC:
        raise BadRecording("cabecera inválida")
    version = data[4]
    if version != HEADER_VERSION:
        raise BadRecording(f"versión de cabecera no soportada: {version}")

    file_uuid = str(uuid_lib.UUID(bytes=data[5:21]))
    started_epoch_ms = int.from_bytes(data[22:30], "little")

    n = (len(data) - HEADER_SIZE) // RECORD_SIZE
    if n == 0:
        raise BadRecording("grabación sin muestras")
    body = data[: HEADER_SIZE + n * RECORD_SIZE]

    # La duración real es la t de la última muestra: contar registros mentiría
    # en cuanto haya un hueco (un cable suelto, un apagón a mitad).
    last = HEADER_SIZE + (n - 1) * RECORD_SIZE
    last_t_ms = int.from_bytes(body[last : last + 4], "little")

    started_at = datetime.fromtimestamp(started_epoch_ms / 1000, timezone.utc)
    ended_at = started_at + timedelta(milliseconds=last_t_ms)
    return file_uuid, started_at, ended_at, round(last_t_ms / 1000), body


async def complete_upload(device_uuid: str, rec_uuid: str, data: bytes):
    """Persiste el .bin que acaba de subir la ESP32 por POST.

    Aqui es donde nace la fila, no al arrancar la grabacion: hasta que el
    fichero no esta en el server no hay nada que enseñar. Los tres pasos van en
    este orden a proposito — con la fila ya escrita, un fallo del Storage deja
    `uploaded_at` en NULL y se ve que esa grabacion existe pero le falta el
    binario.

    Todo es idempotente (upsert de fila y de blob) porque la ESP32 solo borra su
    copia al ver un 200: si la respuesta se pierde, reintenta entera y repetirlo
    sale gratis.
    """
    file_uuid, started_at, ended_at, duration_s, body = _parse(data)
    if file_uuid != rec_uuid:
        raise BadRecording(f"la cabecera dice {file_uuid} y el POST {rec_uuid}")

    file_path = f"{device_uuid}/{rec_uuid}.bin"
    await asyncio.to_thread(
        db.upsert_recording, rec_uuid, device_uuid, started_at, ended_at, duration_s, file_path
    )
    await asyncio.to_thread(db.upload_blob, file_path, body)
    await asyncio.to_thread(db.mark_uploaded, rec_uuid)

    await hub.notify(device_uuid, {"type": "recording_finished", "uuid": rec_uuid})
    log.info("Upload %s: %d B persistidos en Supabase", rec_uuid, len(body))
