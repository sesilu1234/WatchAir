# WatchAir

WatchAir es un proyecto experimental para monitorear respiración en tiempo real usando un ESP32 y un servidor WebSocket. El sistema conecta un dispositivo de medición con una interfaz web para visualizar la señal de presión y controlar la captura.

## Estructura del proyecto

- respi_server.py: servidor WebSocket que conecta el ESP32 con la interfaz web.
- respi_odi/: carpeta del firmware/firmware de ESP32.
- respi-monitor/: interfaz web hecha con Next.js para mostrar la señal en tiempo real.

## Requisitos

- Python 3.10+
- Node.js 18+
- npm

## Ejecutar el servidor WebSocket

```bash
python respi_server.py
```

El servidor queda disponible en el puerto 8080.

## Ejecutar la interfaz web

```bash
cd respi-monitor
npm install
npm run dev
```

Luego abre http://localhost:3000.

## Notas

- El proyecto aún está en fase experimental.
- No se cambió la lógica ni el funcionamiento original; solo se organizó la estructura y se preparó la documentación.
