#pragma once
#include <Arduino.h>
#include <WebSocketsClient.h>

constexpr size_t UPLOAD_CHUNK_SIZE = 2048;

enum class UploadPhase { Idle, WaitingOffset, CrcCatchup, Sending, WaitingConfirm };

// Subida resumible por offset a server2. `resumeOffset` es lo que server2 ya
// tenía (de un intento previo interrumpido); el CRC32 es del fichero entero,
// así que antes de mandar nada nuevo hay que "ponerse al día" leyendo (sin
// reenviar) los bytes [0, resumeOffset) para que el checksum final sea el
// correcto — ver CrcCatchup en uploadTick().
struct UploadState {
  UploadPhase phase = UploadPhase::Idle;
  String uuid;
  uint32_t size = 0;
  uint32_t resumeOffset = 0;
  uint32_t cursor = 0;
  uint32_t crc = 0xFFFFFFFF;
};

extern UploadState uploadState;

void sendHello(WebSocketsClient& ws);
void sendHeartbeat(WebSocketsClient& ws, bool broadcasting, bool recordingNow);
void sendSample(WebSocketsClient& ws, uint32_t tMs, float pressure, float temp);

// Despacha un mensaje de texto entrante de server2. Puede cambiar `broadcasting`
// (start/stop_broadcast) y disparar cambios en `recorder` o en `uploadState`.
void handleServerText(WebSocketsClient& ws, uint8_t* payload, size_t len, bool& broadcasting);

// Arranca la subida de la próxima grabación pendiente si hace falta (no hay
// una en curso, no se está grabando, y no se ha intentado hace <5 s).
void maybeStartUpload(WebSocketsClient& ws);
// Llamar en cada vuelta del loop: manda (o lee para el CRC) el siguiente trozo.
void uploadTick(WebSocketsClient& ws);
