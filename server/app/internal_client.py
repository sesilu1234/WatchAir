import asyncio
import logging

import httpx

from . import config

log = logging.getLogger("watchair.internal_client")

_HEADERS = {"Authorization": f"Bearer {config.INTERNAL_API_SECRET}"}
_RETRY_DELAYS_S = [1, 3, 8]  # server2 no toca Supabase: si el frontend no responde, reintenta unas pocas veces


async def notify_recording_started(*, uuid: str, device_uuid: str, started_at: str) -> bool:
    """POST /api/internal/recordings. El fichero sigue en la ESP32/SD pase lo
    que pase aquí, así que un fallo solo significa que la fila tardará en
    aparecer en la lista, no se pierde nada."""
    body = {"uuid": uuid, "device_uuid": device_uuid, "started_at": started_at}
    return await _post_with_retry(f"{config.FRONTEND_URL}/api/internal/recordings", json=body)


async def notify_recording_complete(*, uuid: str, device_uuid: str, data: bytes) -> bool:
    """POST /api/internal/recordings/{uuid}/complete con el binario ya
    verificado (tamaño+checksum). El fichero se queda en disco en server2
    hasta que esto responde 200: si falla, el próximo reintento (o un reinicio
    de server2 que vuelva a ver el `pending` del hello) puede volver a intentarlo."""
    url = f"{config.FRONTEND_URL}/api/internal/recordings/{uuid}/complete"
    return await _post_with_retry(
        url,
        content=data,
        headers={"X-Device-Uuid": device_uuid, "Content-Type": "application/octet-stream"},
    )


async def _post_with_retry(url: str, *, headers: dict | None = None, **kwargs) -> bool:
    merged_headers = {**_HEADERS, **(headers or {})}
    async with httpx.AsyncClient(timeout=30) as client:
        for attempt, delay in enumerate([0, *_RETRY_DELAYS_S]):
            if delay:
                await asyncio.sleep(delay)
            try:
                resp = await client.post(url, headers=merged_headers, **kwargs)
                if resp.status_code == 200:
                    return True
                log.warning("Frontend %s -> %s (intento %d): %s", url, resp.status_code, attempt, resp.text[:200])
            except httpx.HTTPError as exc:
                log.warning("Frontend %s no responde (intento %d): %s", url, attempt, exc)
    log.error("Frontend %s no confirmó tras %d intentos", url, len(_RETRY_DELAYS_S) + 1)
    return False
