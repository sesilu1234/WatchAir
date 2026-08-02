#pragma once
#include <Arduino.h>
#include <WebSocketsClient.h>

// Mensajes del WS de control con server2. Solo texto: el binario de las
// grabaciones va aparte, por POST (ver uploader.h).
//
// Todo lo de aquí corre en la tarea de red y solo ella toca `ws`
// (WebSocketsClient no es thread-safe).

void sendHello(WebSocketsClient& ws);
// El heartbeat es la única fuente CONTINUA de estado que tiene server2: el
// hello solo cuenta lo que pasa al reconectar. Por eso lleva también si se está
// subiendo, y no solo si se graba: si server2 se reinicia a mitad de una subida,
// esto es lo único que le dice que la grabación sigue viva.
void sendHeartbeat(WebSocketsClient& ws, bool broadcasting, bool recordingNow, bool uploadingNow);
void sendSample(WebSocketsClient& ws, uint32_t tMs, float pressure, float temp);

// Despacha un mensaje de texto entrante de server2: start/stop_broadcast y
// start/stop_recording. Actualiza los flags de shared.h según corresponda.
void handleServerText(WebSocketsClient& ws, uint8_t* payload, size_t len);
