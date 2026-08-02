import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from . import recordings, upload
from .auth import BrowserClaims, InvalidToken, verify_browser_token, verify_device
from .devices import registry

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
            await registry.reconcile_tick()
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
        "devices_online": list(registry.connections.keys()),
        "subscribers": {uuid: len(subs) for uuid, subs in registry.subscribers.items()},
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
    return await recordings.start_recording(claims)


@app.post("/recordings/stop")
async def recordings_stop(claims: BrowserClaims = Depends(browser_claims)):
    return await recordings.stop_recording(claims)


# ===================================================
# WS navegador: live view, solo lectura (connect = suscribirse)
# ===================================================
@app.websocket("/ws")
async def browser_ws(websocket: WebSocket, token: str):
    try:
        claims = verify_browser_token(token)
    except InvalidToken:
        await websocket.close(code=4401)
        return

    await websocket.accept()
    device_uuid = claims.device_uuid
    registry.subscribe(device_uuid, websocket)

    conn = registry.get(device_uuid)
    if conn is not None and registry.desired_broadcasting(device_uuid):
        await conn.send({"type": "start_broadcast"})
    await websocket.send_json(
        {"type": "device_online" if registry.is_online(device_uuid) else "device_offline", "uuid": device_uuid}
    )

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
        remaining_subs = registry.unsubscribe(device_uuid, websocket)
        if remaining_subs == 0:
            conn = registry.get(device_uuid)
            if conn is not None:
                await conn.send({"type": "stop_broadcast"})
        if expired:
            await websocket.close(code=4401)


# ===================================================
# WS ESP32: hello / heartbeat / comandos / muestras / subida
# ===================================================
@app.websocket("/device/ws")
async def device_ws(websocket: WebSocket, uuid: str, secret: str):
    if not verify_device(uuid, secret):
        await websocket.close(code=4403)
        return

    await websocket.accept()
    conn = registry.register_device(uuid, websocket)
    # Simétrico al device_offline que se manda al desconectar/expirar heartbeat
    # (más abajo y en reconcile_tick): sin esto, un browser que ya estaba
    # suscrito cuando el ESP32 se cae nunca se entera de que volvió, porque
    # device_online solo se manda una vez, al conectarse el propio browser.
    await registry.broadcast_to_subscribers(uuid, {"type": "device_online", "uuid": uuid})
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            conn.touch()

            raw_bytes = message.get("bytes")
            if raw_bytes is not None:
                await upload.handle_upload_chunk(conn, raw_bytes)
                continue

            text = message.get("text")
            if text is None:
                continue
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                continue
            await _handle_device_message(conn, data)
    except WebSocketDisconnect:
        pass
    finally:
        registry.unregister_device(uuid, websocket)
        await registry.broadcast_to_subscribers(uuid, {"type": "device_offline", "uuid": uuid})


async def _handle_device_message(conn, data: dict):
    msg_type = data.get("type")

    if msg_type == "hello":
        reported_uuid = data.get("current_recording_uuid") if data.get("rec_en_curso") else None
        await recordings.reconcile_from_hello(conn, reported_uuid)
        conn.pending_uploads = data.get("pending") or []
        log.info(
            "Device %s hello: rec_en_curso=%s pending=%d",
            conn.uuid, data.get("rec_en_curso"), len(conn.pending_uploads),
        )
        return

    if msg_type == "heartbeat":
        conn.reported_broadcasting = bool(data.get("broadcasting"))
        conn.reported_recording = bool(data.get("recording"))
        return

    if msg_type == "recording_ack":
        recordings.handle_ack(conn, data)
        return

    if msg_type == "upload_start":
        await upload.handle_upload_start(conn, data)
        return

    if msg_type == "upload_done":
        await upload.handle_upload_done(conn, data)
        return

    if msg_type is None and "p" in data:
        # muestra en vivo: {"t": ms, "p": pressure, "temp": temperature}
        await registry.broadcast_to_subscribers(conn.uuid, data)
