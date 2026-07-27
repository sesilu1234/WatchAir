# WatchAir server

Relay WebSocket (FastAPI) entre el ESP32 (`/sensor`) y el frontend (`/frontend`).

Gestionado con [uv](https://docs.astral.sh/uv/): `pyproject.toml` declara las dependencias y `uv.lock` las fija para que el entorno sea idéntico en tu máquina y en el EC2. No hace falta crear ni activar un venv a mano, `uv run` lo maneja solo.

## Setup

Instalar uv (si no lo tenés):

```bash
pip install uv
```

Instalar dependencias del proyecto:

```bash
uv sync
```

## Ejecutar

Desarrollo (recarga automática):

```bash
uv run uvicorn server_ws:app --reload --host 0.0.0.0 --port 8080
```

Producción:

```bash
uv run uvicorn server_ws:app --host 0.0.0.0 --port 8080
```

`GET /` devuelve un estado básico (si el ESP32 está conectado y cuántos frontends hay) para comprobar que el servidor está vivo sin necesitar un cliente WebSocket.
