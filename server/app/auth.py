from dataclasses import dataclass

import jwt

from . import config


@dataclass
class BrowserClaims:
    email: str
    device_uuid: str
    exp: float  # epoch seconds; se usa para cerrar el WS cuando caduque


class InvalidToken(Exception):
    pass


def verify_browser_token(token: str) -> BrowserClaims:
    """Valida el JWT corto que firma server1. Firma válida = uuid de fiar:
    no se comprueba contra ninguna lista, el claim manda."""
    try:
        payload = jwt.decode(token, config.JWT_SHARED_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError as exc:
        raise InvalidToken(str(exc)) from exc

    email = payload.get("email")
    device_uuid = payload.get("uuid_device")
    exp = payload.get("exp")
    if not isinstance(email, str) or not isinstance(device_uuid, str) or not isinstance(exp, (int, float)):
        raise InvalidToken("Faltan claims email/uuid_device/exp")
    return BrowserClaims(email=email, device_uuid=device_uuid, exp=exp)
