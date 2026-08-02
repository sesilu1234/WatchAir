import logging
from datetime import datetime, timezone

from supabase import Client, create_client

from . import config

log = logging.getLogger("watchair.db")

# Service role key: bypassa RLS. server2 es el unico que escribe en Supabase.
_client: Client = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)

BUCKET = "watchair"

# Todo esto es sincrono (supabase-py lo es); se llama siempre desde
# asyncio.to_thread para no bloquear el event loop.


def insert_recording(uuid: str, device_uuid: str, started_at: str):
    """Crea la fila al arrancar la grabacion. Idempotente: el ESP32 reconcilia
    el mismo uuid en cada reconexion (hello) y no debe chocar por primary key."""
    _client.table("recordings").upsert(
        {"uuid": uuid, "device_uuid": device_uuid, "started_at": started_at},
        on_conflict="uuid",
        ignore_duplicates=True,
    ).execute()


def complete_recording(uuid: str, device_uuid: str, data: bytes):
    """Sube el binario a Storage y cierra la fila. `ended_at` con valor +
    `file_path` con valor = grabacion completa (el estado es derivado)."""
    row = _client.table("recordings").select("started_at").eq("uuid", uuid).maybe_single().execute()
    if row is None or row.data is None:
        raise RuntimeError(f"la grabacion {uuid} no tiene fila en la BD")

    file_path = f"{device_uuid}/{uuid}.bin"
    _client.storage.from_(BUCKET).upload(
        file_path,
        data,
        {"content-type": "application/octet-stream", "upsert": "true"},
    )

    ended_at = datetime.now(timezone.utc)
    started_at = datetime.fromisoformat(row.data["started_at"].replace("Z", "+00:00"))
    _client.table("recordings").update(
        {
            "ended_at": ended_at.isoformat(),
            "file_path": file_path,
            "duration_seconds": int((ended_at - started_at).total_seconds()),
        }
    ).eq("uuid", uuid).execute()
