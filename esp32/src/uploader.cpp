#include "uploader.h"

#include <HTTPClient.h>
#include <WiFi.h>

#include "recorder.h"
#include "secrets.h"
#include "shared.h"

// Margen de sobra para 6,5 MB por SPI: si algo se atasca, mejor cortar y
// reintentar que quedarse colgado con el fichero abierto.
static const uint16_t UPLOAD_TIMEOUT_MS = 30000;

bool uploadNextPending() {
  if (WiFi.status() != WL_CONNECTED) return false;

  // Elegir candidato y cerrar la puerta a un start_recording, todo bajo el
  // candado: si no, la red podría colarse entre el "no estoy grabando" y el
  // uploadInFlight y acabaríamos con dos usuarios de la SD a la vez.
  String uuid;
  {
    RecorderLock lock;
    if (recordingActive) return false;  // mientras se graba, la SD es para grabar
    std::vector<PendingUpload> pending = recorder.listPending();
    if (pending.empty()) return false;
    uuid = pending[0].uuid;
    uploadInFlight = true;
  }

  bool ok = false;
  File f = recorder.openBin(uuid);
  if (!f) {
    Serial.printf("Upload %s: no se pudo abrir el fichero\n", uuid.c_str());
  } else if (f.size() == 0) {
    Serial.printf("Upload %s: fichero vacio, se descarta\n", uuid.c_str());
    ok = true;  // no hay nada que subir: que deje de estorbar en la cola
  } else {
    size_t size = f.size();
    String path = String("/device/upload?uuid=") + DEVICE_UUID + "&secret=" + DEVICE_SECRET +
                  "&recording=" + uuid;

    HTTPClient http;
    http.begin(SERVER2_HOST, SERVER2_PORT, path);
    http.addHeader("Content-Type", "application/octet-stream");
    http.setTimeout(UPLOAD_TIMEOUT_MS);

    uint32_t t0 = millis();
    int code = http.sendRequest("POST", &f, size);  // File es un Stream: lo manda entero
    ok = (code == 200);
    if (ok) {
      Serial.printf("Upload %s: %u B en %lu ms\n", uuid.c_str(), (unsigned)size,
                    (unsigned long)(millis() - t0));
    } else {
      // Sin 200 no se borra nada: la grabación sigue en la SD y se reintenta.
      Serial.printf("Upload %s: fallo (codigo %d), se reintentara\n", uuid.c_str(), code);
    }
    http.end();
  }
  if (f) f.close();

  {
    RecorderLock lock;
    if (ok) recorder.confirmUploaded(uuid);
    uploadInFlight = false;
  }
  return ok;
}
