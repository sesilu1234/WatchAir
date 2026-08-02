import logging
import zlib
from pathlib import Path

from . import config, internal_client
from .recordings import handle_recording_finished

log = logging.getLogger("watchair.upload")


class UploadSession:
    """Un fichero binario en curso de subida desde la ESP32, reanudable por
    offset. No se guarda nada de esto en BD: si server2 se reinicia a mitad,
    el hello del ESP32 al reconectar lo vuelve a traer en `pending` y arranca
    un `upload_start` nuevo (el fichero parcial en disco sigue ahí)."""

    def __init__(self, uuid: str, device_uuid: str, path: Path, expected_size: int):
        self.uuid = uuid
        self.device_uuid = device_uuid
        self.path = path
        self.expected_size = expected_size

    @property
    def offset(self) -> int:
        return self.path.stat().st_size if self.path.exists() else 0

    def append(self, chunk: bytes):
        with self.path.open("ab") as f:
            f.write(chunk)


def _device_dir(device_uuid: str) -> Path:
    d = config.UPLOADS_DIR / device_uuid
    d.mkdir(parents=True, exist_ok=True)
    return d


async def handle_upload_start(conn, message: dict):
    rec_uuid = message.get("uuid")
    size = message.get("size")
    if not isinstance(rec_uuid, str) or not isinstance(size, int):
        return
    path = _device_dir(conn.uuid) / f"{rec_uuid}.bin"
    conn.upload = UploadSession(rec_uuid, conn.uuid, path, size)
    log.info("Upload %s: arranca en offset %d/%d", rec_uuid, conn.upload.offset, size)
    await conn.send({"type": "upload_offset", "uuid": rec_uuid, "offset": conn.upload.offset})


async def handle_upload_chunk(conn, data: bytes):
    if conn.upload is None:
        return
    conn.upload.append(data)


async def handle_upload_done(conn, message: dict):
    session = conn.upload
    if session is None or message.get("uuid") != session.uuid:
        return

    declared_size = message.get("size")
    declared_checksum = message.get("checksum")
    actual_size = session.offset
    actual_checksum = f"{zlib.crc32(session.path.read_bytes()) & 0xFFFFFFFF:08x}"

    if actual_size != declared_size or actual_checksum != declared_checksum:
        log.warning(
            "Upload %s: no coincide (size %d vs %s, checksum %s vs %s) — se pide reintento",
            session.uuid, actual_size, declared_size, actual_checksum, declared_checksum,
        )
        await conn.send({"type": "upload_error", "uuid": session.uuid, "reason": "checksum_mismatch"})
        return

    ok = await internal_client.notify_recording_complete(
        uuid=session.uuid, device_uuid=session.device_uuid, data=session.path.read_bytes()
    )
    if not ok:
        # el fichero se queda en disco (aquí y en la SD): no se pierde nada,
        # solo no se le dice a la ESP32 que puede borrarlo todavía.
        await conn.send({"type": "upload_error", "uuid": session.uuid, "reason": "frontend_unreachable"})
        return

    await conn.send({"type": "upload_confirmed", "uuid": session.uuid})
    session.path.unlink(missing_ok=True)
    conn.upload = None
    await handle_recording_finished(conn, session.uuid, session.device_uuid)
    log.info("Upload %s: confirmado y persistido en Supabase", session.uuid)
