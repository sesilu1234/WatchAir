# WatchAir server

FastAPI relay between the ESP32 boards (`/sensor`) and the frontend (`/frontend`).

Managed with [uv](https://docs.astral.sh/uv/): `pyproject.toml` declares the dependencies and `uv.lock` pins them, so the environment is identical on your machine and on EC2. No need to create or activate a venv by hand — `uv run` handles it.

## Setup

```bash
pip install uv          # if you don't have it
uv sync                 # install dependencies
cp .env.example .env    # then fill in every variable
```

All variables in `.env` are required: `app/config.py` fails at startup rather than mid-request.

## Run

From this directory:

```bash
# development (auto-reload)
uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8080

# production
uv run uvicorn app.main:app --host 0.0.0.0 --port 8080
```

## Endpoints

| Endpoint | Client | Purpose |
| --- | --- | --- |
| `POST /recordings/start`, `POST /recordings/stop` | browser | Recording control (`Authorization: Bearer <JWT>`) |
| `WS /ws?token=…&live=1` | browser | Device status; `live=1` also streams samples |
| `WS /device/ws?uuid=…&secret=…` | ESP32 | Control channel |
| `POST /device/upload?uuid=…&secret=…&recording=…` | ESP32 | Uploads the finished `.bin` |

## Logs

One line per event, UTC with milliseconds, same format for the app and for uvicorn:

```
2026-08-07 15:36:20.253Z  INFO  uvicorn.access      127.0.0.1:57193 - "POST /recordings/start HTTP/1.1" 401
2026-08-07 15:36:20.879Z  INFO  watchair.recordings Recording rec-abc iniciada en device dev-uuid-1
2026-08-07 15:36:20.879Z  WARN  watchair.hub        Device dev-uuid-1 sin status: se marca offline
```

Everything goes to stderr. The format lives in `app/log_config.py`.
