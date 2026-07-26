import asyncio
import websockets

browsers = set()
esp32 = None


async def handler(websocket):
    global esp32

    path = websocket.request.path

    # =========================
    # ESP32
    # =========================
    if path == "/sensor":
        esp32 = websocket
        print("ESP32 connected")

        try:
            async for message in websocket:
                print("ESP32:", message)

                # Sensor → Frontend
                websockets.broadcast(browsers, message)

        except websockets.ConnectionClosed:
            print("ESP32 disconnected")

        finally:
            if esp32 is websocket:
                esp32 = None


    # =========================
    # FRONTEND / NEXT.JS
    # =========================
    elif path == "/frontend":
        browsers.add(websocket)
        print("Frontend connected")

        try:
            async for message in websocket:
                print("Frontend:", message)

                # Frontend → ESP32
                if esp32 is not None:
                    await esp32.send(message)

        except websockets.ConnectionClosed:
            pass

        finally:
            browsers.discard(websocket)
            print("Frontend disconnected")


    else:
        await websocket.close(
            code=1008,
            reason="Ruta no válida"
        )


async def main():
    async with websockets.serve(
        handler,
        "0.0.0.0",
        8080
    ):
        print(
            "WS activo en :8080 | "
            "ESP32 -> /sensor | "
            "Frontend -> /front"
        )

        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())