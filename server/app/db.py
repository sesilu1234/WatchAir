import logging
from datetime import datetime, timezone

from supabase import Client, create_client

from . import config

log = logging.getLogger("watchair.db")

# Service role key: bypassa RLS. server2 es el unico que escribe en Supabase.
_client: Client = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)

BUCKET = "watchair"

# Todo esto es sincrono (supabase-py lo es); se llama siempre desde
# asyncio.to_thread para no bloquear el event loop. Los tres pasos de una subida
# van en orden desde recordings.complete_upload y cada uno puede fallar por su
# cuenta: la ESP32 reintenta la subida entera y repetir cualquiera sale gratis.


def upsert_recording(
    uuid: str,
    device_uuid: str,
    started_at: datetime,
    ended_at: datetime,
    duration_seconds: int,
    file_path: str,
):
    """Crea (o reescribe) la fila con lo que dice la cabecera del fichero.

    `uploaded_at` no aparece a proposito: al insertar queda NULL por defecto, y
    en un reintento se conserva el que ya hubiera en vez de volver a ponerlo a
    NULL a mitad de camino.
    """
    _client.table("recordings").upsert(
        {
            "uuid": uuid,
            "device_uuid": device_uuid,
            "started_at": started_at.isoformat(),
            "ended_at": ended_at.isoformat(),
            "duration_seconds": duration_seconds,
            "file_path": file_path,
        },
        on_conflict="uuid",
    ).execute()


def upload_blob(file_path: str, data: bytes):
    _client.storage.from_(BUCKET).upload(
        file_path,
        data,
        {"content-type": "application/octet-stream", "upsert": "true"},
    )


def mark_uploaded(uuid: str):
    """El binario ya esta en Storage. `uploaded_at` con valor = grabacion
    completa y lista para pintar; NULL = la fila existe pero le falta el fichero."""
    _client.table("recordings").update(
        {"uploaded_at": datetime.now(timezone.utc).isoformat()}
    ).eq("uuid", uuid).execute()
