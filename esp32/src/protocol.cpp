#include "protocol.h"
#include "recorder.h"
#include "secrets.h"
#include <ArduinoJson.h>

// Lo mantiene main.cpp con el resultado de la última lectura I2C: es la
// precondición "sensor respondiendo" del start.
extern bool sensorOk;

UploadState uploadState;

// --- CRC32 estilo zlib (poly 0xEDB88320, init/final 0xFFFFFFFF) — tiene que
// coincidir con lo que valida server/app/upload.py (zlib.crc32 en Python). ---
static uint32_t crc32Table[256];
static bool crc32TableReady = false;

static void buildCrc32Table() {
  for (uint32_t i = 0; i < 256; i++) {
    uint32_t c = i;
    for (int k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320UL ^ (c >> 1)) : (c >> 1);
    crc32Table[i] = c;
  }
  crc32TableReady = true;
}

static void crc32Update(uint32_t& crc, const uint8_t* buf, size_t len) {
  if (!crc32TableReady) buildCrc32Table();
  for (size_t i = 0; i < len; i++) crc = crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >> 8);
}

// --- mensajes salientes ---

void sendHello(WebSocketsClient& ws) {
  JsonDocument doc;
  doc["type"] = "hello";
  doc["uuid"] = DEVICE_UUID;
  bool recNow = recorder.isRecording();
  doc["rec_en_curso"] = recNow;
  if (recNow) doc["current_recording_uuid"] = recorder.currentUuid();
  else doc["current_recording_uuid"] = nullptr;
  doc["t_ms"] = millis();

  JsonArray pending = doc["pending"].to<JsonArray>();
  for (const auto& p : recorder.listPending()) {
    JsonObject o = pending.add<JsonObject>();
    o["uuid"] = p.uuid;
    o["size"] = p.size;
  }

  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

void sendHeartbeat(WebSocketsClient& ws, bool broadcasting, bool recordingNow) {
  JsonDocument doc;
  doc["type"] = "heartbeat";
  doc["broadcasting"] = broadcasting;
  doc["recording"] = recordingNow;
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

// A 25 Hz: JSON a mano en vez de ArduinoJson, para no pagar su overhead en el camino caliente.
void sendSample(WebSocketsClient& ws, uint32_t tMs, float pressure, float temp) {
  char buf[64];
  snprintf(buf, sizeof(buf), "{\"t\":%lu,\"p\":%.3f,\"temp\":%.2f}", (unsigned long)tMs, pressure, temp);
  ws.sendTXT(buf);
}

// rec=false + motivo cuando falla alguna precondición del start: así el
// browser ve el porqué en vez de esperar a que expire el timeout del ACK.
static void sendRecordingAck(WebSocketsClient& ws, const String& uuid, bool ok, const char* reason) {
  JsonDocument doc;
  doc["type"] = "recording_ack";
  doc["uuid"] = uuid;
  doc["rec"] = ok;
  if (!ok) doc["reason"] = reason;
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

static void sendUploadStart(WebSocketsClient& ws, const String& uuid, uint32_t size) {
  JsonDocument doc;
  doc["type"] = "upload_start";
  doc["uuid"] = uuid;
  doc["size"] = size;
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

static void sendUploadDone(WebSocketsClient& ws) {
  uint32_t finalCrc = uploadState.crc ^ 0xFFFFFFFFUL;
  char hex[9];
  snprintf(hex, sizeof(hex), "%08x", finalCrc);

  JsonDocument doc;
  doc["type"] = "upload_done";
  doc["uuid"] = uploadState.uuid;
  doc["size"] = uploadState.size;
  doc["checksum"] = hex;
  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

// --- subida ---

static uint32_t lastUploadAttemptMs = 0;

void maybeStartUpload(WebSocketsClient& ws) {
  if (uploadState.phase != UploadPhase::Idle) return;
  if (recorder.isRecording()) return; // no se sube mientras se graba
  if (millis() - lastUploadAttemptMs < 5000) return;
  lastUploadAttemptMs = millis();

  auto pending = recorder.listPending();
  if (pending.empty()) return;

  const PendingUpload& p = pending[0];
  uint32_t finalSize = recorder.sizeOf(p.uuid);
  if (finalSize == 0) return;

  uploadState = UploadState{};
  uploadState.uuid = p.uuid;
  uploadState.size = finalSize;
  uploadState.phase = UploadPhase::WaitingOffset;

  sendUploadStart(ws, p.uuid, finalSize);
}

void uploadTick(WebSocketsClient& ws) {
  if (uploadState.phase == UploadPhase::CrcCatchup) {
    if (uploadState.cursor >= uploadState.resumeOffset) {
      uploadState.phase = UploadPhase::Sending;
      return;
    }
    uint8_t buf[UPLOAD_CHUNK_SIZE];
    uint32_t remaining = uploadState.resumeOffset - uploadState.cursor;
    size_t want = remaining < UPLOAD_CHUNK_SIZE ? remaining : UPLOAD_CHUNK_SIZE;
    size_t got = recorder.readChunk(uploadState.uuid, uploadState.cursor, buf, want);
    if (got == 0) {
      uploadState.phase = UploadPhase::Idle;
      return;
    }
    crc32Update(uploadState.crc, buf, got);
    uploadState.cursor += got;
    return;
  }

  if (uploadState.phase == UploadPhase::Sending) {
    if (uploadState.cursor >= uploadState.size) {
      sendUploadDone(ws);
      uploadState.phase = UploadPhase::WaitingConfirm;
      return;
    }
    uint8_t buf[UPLOAD_CHUNK_SIZE];
    uint32_t remaining = uploadState.size - uploadState.cursor;
    size_t want = remaining < UPLOAD_CHUNK_SIZE ? remaining : UPLOAD_CHUNK_SIZE;
    size_t got = recorder.readChunk(uploadState.uuid, uploadState.cursor, buf, want);
    if (got == 0) {
      uploadState.phase = UploadPhase::Idle;
      return;
    }
    crc32Update(uploadState.crc, buf, got);
    ws.sendBIN(buf, got);
    uploadState.cursor += got;
    return;
  }
  // Idle / WaitingOffset / WaitingConfirm: nada que hacer hasta que responda server2.
}

// --- mensajes entrantes ---

void handleServerText(WebSocketsClient& ws, uint8_t* payload, size_t len, bool& broadcasting) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len) != DeserializationError::Ok) return;

  const char* type = doc["type"] | "";

  if (strcmp(type, "start_broadcast") == 0) {
    broadcasting = true;
    return;
  }
  if (strcmp(type, "stop_broadcast") == 0) {
    broadcasting = false;
    return;
  }
  if (strcmp(type, "start_recording") == 0) {
    String uuid = doc["uuid"] | "";
    if (uuid.length() == 0) return;
    // start con un uuid distinto al que graba: se cierra y descarta la vieja y
    // se arranca de cero con la nueva, tal como espera server2.
    if (recorder.isRecording()) {
      if (recorder.currentUuid() == uuid) {  // idempotente: ya la estábamos grabando
        sendRecordingAck(ws, uuid, true, "");
        return;
      }
      recorder.stop();
    }
    const char* err = recorder.start(uuid, sensorOk);
    sendRecordingAck(ws, uuid, err[0] == '\0', err);
    return;
  }
  if (strcmp(type, "stop_recording") == 0) {
    recorder.stop();
    maybeStartUpload(ws);
    return;
  }
  if (strcmp(type, "upload_offset") == 0) {
    if (uploadState.phase == UploadPhase::WaitingOffset) {
      uploadState.resumeOffset = doc["offset"] | 0;
      uploadState.cursor = 0;
      uploadState.crc = 0xFFFFFFFF;
      uploadState.phase = uploadState.resumeOffset > 0 ? UploadPhase::CrcCatchup : UploadPhase::Sending;
    }
    return;
  }
  if (strcmp(type, "upload_confirmed") == 0) {
    String uuid = doc["uuid"] | "";
    if (uploadState.phase == UploadPhase::WaitingConfirm && uuid == uploadState.uuid) {
      recorder.confirmUploaded(uuid);
      uploadState.phase = UploadPhase::Idle;
      maybeStartUpload(ws); // por si hay más grabaciones pendientes
    }
    return;
  }
  if (strcmp(type, "upload_error") == 0) {
    const char* reason = doc["reason"] | "?";
    Serial.printf("Upload error: %s\n", reason);
    uploadState.phase = UploadPhase::Idle; // maybeStartUpload lo reintenta (autothrottle de 5 s)
    return;
  }
}
