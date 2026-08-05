import os


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Falta la variable de entorno {name}")
    return value


JWT_SHARED_SECRET = _require("JWT_SHARED_SECRET")

# server2 es el unico que escribe en Supabase (Postgres + Storage). El frontend
# solo lee `devices` para resolver email -> uuid del aparato en el login.
SUPABASE_URL = _require("SUPABASE_URL").rstrip("/")
SUPABASE_SERVICE_KEY = _require("SUPABASE_SERVICE_KEY")


def _parse_device_secrets(raw: str) -> dict[str, str]:
    """"uuid:secreto,uuid:secreto" -> {uuid: secreto}.

    Un secreto por aparato, no uno compartido: con el compartido, cualquiera de
    las ESP32 podia hacerse pasar por otra.
    """
    secrets: dict[str, str] = {}
    for pair in raw.split(","):
        uuid, sep, secret = pair.strip().partition(":")
        if not sep or not uuid or not secret:
            raise RuntimeError(f"DEVICE_SECRETS mal formado en: {pair!r}")
        secrets[uuid] = secret
    return secrets


# Aprovisionamiento hardcodeado: un aparato por usuario. Las claves de este dict
# son la lista blanca de UUIDs; el username/email vive en Supabase.
DEVICE_SECRETS: dict[str, str] = _parse_device_secrets(_require("DEVICE_SECRETS"))

# 3 s (un solo status de margen) era demasiado ajustado: un loop() lento en
# el ESP32 bastaba para marcarlo offline y forzar reconexion en bucle.
ONLINE_TIMEOUT_S = 7
RECONCILE_GRACE_S = 3  # desajuste deseado/reportado que se tolera antes de reenviar
ACK_TIMEOUT_S = 5

# Tope de 12 h a 25 Hz (6 B por muestra) = 6,5 MB. El margen es para no rechazar
# una grabacion legitima por un cambio de formato; el cuerpo se lee en memoria,
# asi que el limite es lo unico que evita que un POST cualquiera la agote.
MAX_UPLOAD_BYTES = 16 * 1024 * 1024
