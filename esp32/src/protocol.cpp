#include "protocol.h"

#include <ArduinoJson.h>

#include "recorder.h"
#include "secrets.h"
#include "shared.h"

// --- mensajes salientes ---

void sendStatus(WebSocketsClient& ws) {
  // Nada de esto toca la SD ni coge el candado: la instantánea del recorder y
  // los flags ya están en RAM (ver recorder.h). Por eso tampoco viaja el espacio
  // libre de la tarjeta: SD.usedBytes() recorre la FAT y puede tardar cientos de
  // ms, y no sirve de nada — si no hay sitio, el NACK del start ya lo dice.
  const char* recUuid = recorder.recUuidSnapshot();
  bool recording = recUuid[0] != '\0';

  JsonDocument doc;
  doc["type"] = "status";
  doc["uuid"] = DEVICE_UUID;
  doc["boot_id"] = bootId;
  if (recording) {
    doc["rec_uuid"] = recUuid;
    // t=0 de la grabación: es lo que le da nombre en la base de datos y en la UI.
    doc["rec_started_epoch_ms"] = recorder.startedEpochMsSnapshot();
  } else {
    doc["rec_uuid"] = nullptr;
    doc["rec_started_epoch_ms"] = nullptr;
  }
  doc["recording"] = recording;
  doc["broadcasting"] = broadcasting;
  doc["uploading"] = uploadInFlight;
  doc["pending"] = recorder.pendingSnapshot();
  doc["ntp_ok"] = timeIsSynced();
  doc["t_ms"] = millis();  // gratis, y delata un bucle de reinicios

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

// El comando que no se puede cumplir se contesta con un NACK y su motivo, para
// que el browser vea el porqué en vez de esperar a que expire el timeout. El
// caso bueno no lleva respuesta propia: lo confirma el `status`.
//
// `uuid` es el de la grabación pedida en un start, y nullptr en un stop: server2
// espera exactamente eso para casar el NACK con el comando que lanzó.
static void sendNack(WebSocketsClient& ws, const char* uuid, const char* reason) {
  JsonDocument doc;
  doc["type"] = "nack";
  if (uuid != nullptr) doc["uuid"] = uuid;
  else doc["uuid"] = nullptr;
  doc["reason"] = reason;
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
    statusDirty = true;
    return;
  }
  if (strcmp(type, "stop_broadcast") == 0) {
    broadcasting = false;
    statusDirty = true;
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
      if (recorder.isRecording()) {
        // Nunca se pisa una grabación viva: si server2 manda un start estando
        // grabando es que su estado iba atrasado, y quien manda es la SD.
        err = recorder.currentUuid() == uuid ? "" : "ya hay una grabacion en curso";
      } else if (uploadInFlight) {
        // Grabar y subir se pelearían por la SD. Es un NACK normal: server2 lo
        // convierte en un 409 con el motivo y el browser puede reintentar.
        err = "subiendo una grabacion, reintenta en unos segundos";
      } else {
        // Antes de encolar nada nuevo: se corta el grifo del sampler, se arranca
        // y se tira lo que quedara de la grabación anterior. El orden importa,
        // si no la nueva empezaría con muestras selladas contra el t=0 viejo.
        recordingActive = false;
        err = recorder.start(uuid, sensorOk);
        resetSampleQueue();
        recordingActive = recorder.isRecording();
      }
    }
    if (err[0] == '\0') statusDirty = true;  // el status es la confirmación
    else sendNack(ws, uuid.c_str(), err);
    return;
  }
  if (strcmp(type, "stop_recording") == 0) {
    bool wasRecording;
    {
      RecorderLock lock;
      wasRecording = recorder.isRecording();
      recorder.stop();
      recordingActive = false;
    }
    // No se lanza la subida aquí: la tarea de SD ve que ya no se graba y la
    // arranca ella sola en su siguiente vuelta, después de este status.
    if (wasRecording) statusDirty = true;
    else sendNack(ws, nullptr, "no hay ninguna grabacion en curso");
    return;
  }
}
