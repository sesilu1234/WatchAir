"""Una unica configuracion de logging para todo: la app y uvicorn.

Sin esto, uvicorn instala sus propios handlers con `propagate=False`, asi que sus
lineas nunca pasan por las nuestras y la consola acaba mezclando dos formatos
distintos. Aqui se le quitan esos handlers y todo baja al de root.

Se aplica al importar `app.main`, que ocurre despues de que uvicorn haya puesto
los suyos (tanto en arranque normal como con `--reload`), asi que esta config es
siempre la ultima en ganar.
"""

import logging
import logging.config
import time

# Todo en UTC: el EC2 va en UTC y los timestamps del ESP32 son epoch, asi que
# cruzar un log con una grabacion no pide conversiones mentales. Los milisegundos
# no son adorno: casi todo lo que se depura aqui son carreras (ack en vuelo,
# ONLINE_TIMEOUT_S, reconciliacion) y con segundos enteros no se ven.
_FORMAT = "%(asctime)s.%(msecs)03dZ  %(levelshort)-5s %(logname)-19s %(message)s"
_DATEFMT = "%Y-%m-%d %H:%M:%S"

# Columna de nivel de 5: sin recortar, WARNING y CRITICAL la desalinean.
_LEVELS = {"WARNING": "WARN", "CRITICAL": "CRIT"}
# uvicorn manda por `uvicorn.error` tambien los mensajes de arranque, que son
# INFO; leer "ERROR" en el nombre de un INFO confunde mas que ayuda.
_NAMES = {"uvicorn.error": "uvicorn"}


class Formatter(logging.Formatter):
    converter = time.gmtime  # la Z del formato tiene que ser verdad

    def format(self, record: logging.LogRecord) -> str:
        record.levelshort = _LEVELS.get(record.levelname, record.levelname)
        record.logname = _NAMES.get(record.name, record.name)
        return super().format(record)


def setup(level: int = logging.INFO) -> None:
    logging.config.dictConfig(
        {
            "version": 1,
            "disable_existing_loggers": False,
            "formatters": {
                "default": {"()": Formatter, "format": _FORMAT, "datefmt": _DATEFMT},
            },
            # Un solo stream para todo. uvicorn manda el access log a stdout y el
            # resto a stderr; con dos streams sin sincronizar las lineas se
            # entrecortan entre si al salir por la misma terminal.
            "handlers": {
                "console": {
                    "class": "logging.StreamHandler",
                    "formatter": "default",
                    "stream": "ext://sys.stderr",
                },
            },
            "root": {"handlers": ["console"], "level": level},
            # Sin handler propio y propagando: caen en el de root y salen con el
            # mismo formato que los nuestros.
            "loggers": {
                name: {"handlers": [], "propagate": True}
                for name in ("uvicorn", "uvicorn.error", "uvicorn.access")
            },
        }
    )
