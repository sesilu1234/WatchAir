import os
from pathlib import Path


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Falta la variable de entorno {name}")
    return value


JWT_SHARED_SECRET = _require("JWT_SHARED_SECRET")
DEVICE_SECRET = _require("DEVICE_SECRET")

# server2 es el unico que escribe en Supabase (Postgres + Storage). El frontend
# solo lee `devices` para resolver email -> uuid del aparato en el login.
SUPABASE_URL = _require("SUPABASE_URL").rstrip("/")
SUPABASE_SERVICE_KEY = _require("SUPABASE_SERVICE_KEY")

# Aprovisionamiento hardcodeado: un aparato por usuario. Solo se usa para el
# gate de auth del WS del ESP32; el username/email vive en Supabase.
DEVICE_UUIDS = {
    "8d257ddd-79bc-4fc7-969c-8ba42d315b22",  # Ulises
    "01bbe27b-7b83-4247-839e-0826b23f473c",  # Angela
    "af87778a-9e0c-4445-ad5e-62d78943272e",  # Minerva
}

# 3 s (un solo heartbeat de margen) era demasiado ajustado: un loop() lento en
# el ESP32 bastaba para marcarlo offline y forzar reconexion en bucle.
ONLINE_TIMEOUT_S = 7
RECONCILE_GRACE_S = 3  # desajuste deseado/reportado que se tolera antes de reenviar
ACK_TIMEOUT_S = 5

UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
