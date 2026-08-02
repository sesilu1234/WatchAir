import json
import os
from pathlib import Path

# server2 no toca Supabase: solo necesita saber qué UUID de device son válidos
# para el gate de auth del WS del ESP32. El resto (username/email) vive en
# Supabase y lo lee el frontend.
_DEVICES_FILE = Path(__file__).resolve().parent.parent / "devices.json"


def _load_provisioned_uuids() -> set[str]:
    data = json.loads(_DEVICES_FILE.read_text(encoding="utf-8"))
    return set(data["uuids"])


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Falta la variable de entorno {name}")
    return value


JWT_SHARED_SECRET = _require("JWT_SHARED_SECRET")
DEVICE_SECRET = _require("DEVICE_SECRET")
INTERNAL_API_SECRET = _require("INTERNAL_API_SECRET")
FRONTEND_URL = _require("FRONTEND_URL").rstrip("/")

PROVISIONED_DEVICE_UUIDS = _load_provisioned_uuids()

# --- Protocolo ---
HEARTBEAT_INTERVAL_S = 2
ONLINE_TIMEOUT_S = 7  # last_seen más viejo que esto -> offline
# 3s (apenas 1 heartbeat de margen sobre HEARTBEAT_INTERVAL_S) era demasiado
# ajustado: un solo loop() lento en el ESP32 (una lectura de SD, un retransmit
# WiFi) bastaba para marcar el device offline y forzar una reconexión — visto
# en producción como un ciclo conectado/desconectado cada pocos segundos.
RECONCILE_GRACE_S = 3  # tiempo que se tolera un desajuste deseado/reportado antes de reenviar el comando
RECORDING_ACK_TIMEOUT_S = 5
LOOP_TIME_MS = 40  # 25 Hz, tiene que coincidir con el firmware

UPLOADS_DIR = Path(__file__).resolve().parent.parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)
