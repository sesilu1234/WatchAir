#include "protocol.h"

#include <ArduinoJson.h>

#include "recorder.h"
#include "secrets.h"
#include "shared.h"

// --- mensajes salientes ---

void sendHello(WebSocketsClient& ws) {
  // Se lee el recorder bajo candado y se suelta antes de serializar y mandar:
  // nunca se hace una llamada de red con el candado cogido.
  bool recNow;
  String currentUuid;
  {
    RecorderLock lock;
    recNow = recorder.isRecording();
    currentUuid = recorder.currentUuid();
  }

  JsonDocument doc;
  doc["type"] = "hello";
  doc["uuid"] = DEVICE_UUID;
  doc["rec_en_curso"] = recNow;
  if (recNow) doc["current_recording_uuid"] = currentUuid;
  else doc["current_recording_uuid"] = nullptr;
  doc["t_ms"] = millis();

  String out;
  serializeJson(doc, out);
  ws.sendTXT(out);
}

void sendHeartbeat(WebSocketsClient& ws, bool broadcastingNow, bool recordingNow, bool uploadingNow) {
  JsonDocument doc;
  doc["type"] = "heartbeat";
  doc["broadcasting"] = broadcastingNow;
  doc["recording"] = recordingNow;
  doc["uploading"] = uploadingNow;
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

// --- mensajes entrantes ---

void handleServerText(WebSocketsClient& ws, uint8_t* payload, size_t len) {
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

    // El resultado se decide bajo candado y se contesta fuera: sendTXT puede
    // bloquear y no queremos a la tarea de SD esperando por eso.
    const char* err;
    {
      RecorderLock lock;
      if (uploadInFlight) {
        // Grabar y subir se pelearían por la SD. Es un NACK normal: server2 lo
        // convierte en un 409 con el motivo y el browser puede reintentar.
        err = "subiendo una grabacion, reintenta en unos segundos";
      } else if (recorder.isRecording() && recorder.currentUuid() == uuid) {
        err = "";  // idempotente: ya la estábamos grabando
      } else {
        // start con un uuid distinto al que graba: se cierra y descarta la
        // vieja y se arranca de cero con la nueva, tal como espera server2.
        if (recorder.isRecording()) recorder.stop();
        err = recorder.start(uuid, sensorOk);
        recordingActive = recorder.isRecording();
      }
    }
    sendRecordingAck(ws, uuid, err[0] == '\0', err);
    return;
  }
  if (strcmp(type, "stop_recording") == 0) {
    RecorderLock lock;
    recorder.stop();
    recordingActive = false;
    // No se lanza la subida aquí: la tarea de SD ve que ya no se graba y la
    // arranca ella sola en su siguiente vuelta.
    return;
  }
}
