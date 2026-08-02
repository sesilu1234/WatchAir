import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Request,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware

from . import config, hub, recordings
from .auth import BrowserClaims, InvalidToken, verify_browser_token

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("watchair")


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_reconcile_loop())
    yield
    task.cancel()


async def _reconcile_loop():
    while True:
        await asyncio.sleep(1)
        try:
            await hub.reconcile_tick()
        except Exception:
            log.exception("Fallo en el bucle de reconciliación")


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # TODO: restringir al dominio de Vercel en cuanto esté desplegado
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/status")
def status():
    return {
        "devices_online": list(hub.devices),
        "subscribers": {uuid: len(subs) for uuid, subs in hub.subscribers.items()},
    }


# ===================================================
# HTTP: control de grabación (navegador, Bearer JWT)
# ===================================================
async def browser_claims(authorization: str | None = Header(default=None)) -> BrowserClaims:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Falta Authorization: Bearer <token>")
    try:
        return verify_browser_token(authorization.removeprefix("Bearer "))
    except InvalidToken as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc


@app.post("/recordings/start")
async def recordings_start(claims: BrowserClaims = Depends(browser_claims)):
    return await recordings.start(claims)


@app.post("/recordings/stop")
async def recordings_stop(claims: BrowserClaims = Depends(browser_claims)):
    return await recordings.stop(claims)


# ===================================================
# WS navegador: live view, solo lectura (conectarse = suscribirse)
# ===================================================
@app.websocket("/ws")
async def browser_ws(websocket: WebSocket, token: str):
    try:
        claims = verify_browser_token(token)
    except InvalidToken:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    uuid = claims.device_uuid
    hub.subscribers.setdefault(uuid, set()).add(websocket)

    # Emisión como estado derivado: acabamos de pasar de 0 a >=1 suscriptor.
    dev = hub.devices.get(uuid)
    if dev is not None:
        await dev.send({"type": "start_broadcast"})
    await websocket.send_json(
        {"type": "device_online" if dev is not None else "device_offline", "uuid": uuid}
    )
    if dev is not None:
        # Estado de partida: quien entra a mitad de una subida tiene que verlo ya,
        # sin esperar a que el heartbeat cambie de valor (solo avisa en cambios).
        await websocket.send_json(recordings.device_status(dev))

    expired = False
    try:
        while True:
            remaining = claims.exp - time.time()
            if remaining <= 0:
                expired = True
                break
            try:
                await asyncio.wait_for(websocket.receive_text(), timeout=remaining)
            except asyncio.TimeoutError:
                expired = True
                break
    except WebSocketDisconnect:
        pass
    finally:
        subs = hub.subscribers.get(uuid)
        if subs is not None:
            subs.discard(websocket)
            if not subs:
                del hub.subscribers[uuid]
                dev = hub.devices.get(uuid)
                if dev is not None:
                    await dev.send({"type": "stop_broadcast"})
        if expired:
            await websocket.close(code=4401)


# ===================================================
# ESP32: WS de control + POST de subida
# ===================================================
def _device_authorized(uuid: str, secret: str) -> bool:
    return secret == config.DEVICE_SECRET and uuid in config.DEVICE_UUIDS


@app.post("/device/upload")
async def device_upload(uuid: str, secret: str, recording: str, request: Request):
    """La ESP32 sube el .bin entero. Un 200 es su permiso para borrarlo de la SD,
    asi que cualquier fallo aqui tiene que salir como error: reintentara sola."""
    if not _device_authorized(uuid, secret):
        raise HTTPException(status_code=403, detail="Credenciales de dispositivo inválidas")

    # Se acumula con tope en vez de request.body(): un Content-Length mentido no
    # puede hacer crecer esto sin limite.
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > config.MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="Grabación demasiado grande")
    if not data:
        raise HTTPException(status_code=400, detail="Cuerpo vacío")

    try:
        await recordings.complete_upload(uuid, recording, bytes(data))
    except Exception as exc:
        log.exception("Upload %s: no se pudo persistir", recording)
        raise HTTPException(status_code=503, detail=f"{exc}"[:200]) from exc
    return {"ok": True}


@app.websocket("/device/ws")
async def device_ws(websocket: WebSocket, uuid: str, secret: str):
    if not _device_authorized(uuid, secret):
        await websocket.close(code=4403)
        return

    await websocket.accept()
    dev = hub.Device(uuid, websocket)
    hub.devices[uuid] = dev
    log.info("Device %s conectado", uuid)
    # Simétrico al device_offline: sin esto, un browser ya suscrito cuando el
    # ESP32 se cayó nunca se entera de que volvió.
    await hub.notify(uuid, {"type": "device_online", "uuid": uuid})

    try:
        while True:
            # Solo texto: el binario de las grabaciones va por POST /device/upload.
            text = await websocket.receive_text()
            dev.last_seen = time.monotonic()
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                continue
            await _handle_device_message(dev, data)
    except WebSocketDisconnect:
        pass
    finally:
        if hub.devices.get(uuid) is dev:  # no pisar una reconexión más nueva
            del hub.devices[uuid]
        log.info("Device %s desconectado", uuid)
        await hub.notify(uuid, {"type": "device_offline", "uuid": uuid})


async def _handle_device_message(dev: hub.Device, data: dict):
    msg_type = data.get("type")

    if msg_type == "hello":
        reported = data.get("current_recording_uuid") if data.get("rec_en_curso") else None
        await recordings.reconcile_hello(dev, reported)
        log.info("Device %s hello: rec_en_curso=%s", dev.uuid, data.get("rec_en_curso"))
    elif msg_type == "heartbeat":
        dev.broadcasting = bool(data.get("broadcasting"))
        await recordings.reconcile_heartbeat(
            dev, bool(data.get("recording")), bool(data.get("uploading"))
        )
    elif msg_type == "recording_ack":
        if dev.ack is not None and data.get("uuid") == dev.ack_uuid and not dev.ack.done():
            # rec=false => alguna precondición del ESP32 falló; el motivo sube al browser
            dev.ack.set_result((bool(data.get("rec", True)), data.get("reason") or ""))
    elif msg_type is None and "p" in data:
        # muestra en vivo {"t": ms, "p": presion, "temp": temperatura}, sin batching
        await hub.notify(dev.uuid, data)
