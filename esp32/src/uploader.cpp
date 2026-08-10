#include "uploader.h"

#include <HTTPClient.h>
#include <WiFi.h>

#include "recorder.h"
#include "secrets.h"
#include "shared.h"

// Margen de sobra para 6,5 MB por SPI: si algo se atasca, mejor cortar y
// reintentar que quedarse colgado con el fichero abierto.
static const uint16_t UPLOAD_TIMEOUT_MS = 30000;

// El único código, aparte del 200, que autoriza a borrar: el server dice que
// ese fichero no es aceptable y no lo va a ser nunca (cabecera ilegible, sin
// muestras, uuid que no cuadra). Ver device_upload en el server.
//
// Cualquier otro error se reintenta, porque cualquier otro error puede
// arreglarse solo: el server caído, la red, o un secreto todavía sin desplegar.
static const int HTTP_RECHAZADA = 422;

// Por dónde seguir la próxima vez. Antes se cogía siempre `pending[0]`, así que
// un fichero que fallara para siempre se quedaba clavado en la cabeza y las
// grabaciones de detrás no subían nunca. Con esto, un fichero problemático
// cuesta un intento por vuelta y no la cola entera.
static size_t nextPending = 0;

UploadResult uploadNextPending() {
  if (WiFi.status() != WL_CONNECTED) return UploadResult::Idle;

  // Elegir candidato y cerrar la puerta a un start_recording, todo bajo el
  // candado: si no, la red podría colarse entre el "no estoy grabando" y el
  // uploadInFlight y acabaríamos con dos usuarios de la SD a la vez.
  String uuid;
  {
    RecorderLock lock;
    if (recordingActive) return UploadResult::Idle;  // mientras se graba, la SD es para grabar
    if (recorder.pendingSnapshot() == 0) return UploadResult::Idle;  // contador en RAM
    std::vector<PendingUpload> pending = recorder.listPending();
    if (pending.empty()) return UploadResult::Idle;
    if (nextPending >= pending.size()) nextPending = 0;  // la lista encogió: vuelta a empezar
    uuid = pending[nextPending].uuid;
    uploadInFlight = true;
  }
  statusDirty = true;  // la barrita de subida del frontend sale de aquí

  UploadResult result = UploadResult::Failed;
  bool remove = false;  // sacarlo de la SD: o está guardado, o no vale para nada
  File f = recorder.openBin(uuid);
  if (!f) {
    // Está en el listado pero no abre. Puede ser un tropiezo de la tarjeta, así
    // que no se borra; el cursor de arriba impide que tape a los demás.
    Serial.printf("Upload %s: no se pudo abrir el fichero\n", uuid.c_str());
  } else if (f.size() <= HEADER_SIZE) {
    // Solo cabecera: una grabación parada antes de la primera muestra. No hay
    // ningún dato que perder, y el server la rechazaría por vacía para siempre.
    Serial.printf("Upload %s: sin ninguna muestra, se descarta\n", uuid.c_str());
    remove = true;
    result = UploadResult::Progress;
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
    if (code == 200) {
      remove = true;
      result = UploadResult::Progress;
      Serial.printf("Upload %s: %u B en %lu ms\n", uuid.c_str(), (unsigned)size,
                    (unsigned long)(millis() - t0));
    } else if (code == HTTP_RECHAZADA) {
      // El server ha visto el fichero y dice que no sirve. Se borra: dejarlo
      // ahí significaba remandarlo entero cada pocos segundos, para siempre, y
      // ese goteo se lleva por delante el ancho de banda del live view.
      //
      // Cuenta como progreso aunque no se haya guardado nada: la cola tiene un
      // fichero menos y el siguiente intento puede ir a por otro sin esperar.
      remove = true;
      result = UploadResult::Progress;
      Serial.printf("Upload %s: rechazada por el server, se borra de la SD\n", uuid.c_str());
    } else {
      // Todo lo demás puede arreglarse solo: la grabación sigue en la SD.
      Serial.printf("Upload %s: fallo (codigo %d), se reintentara\n", uuid.c_str(), code);
    }
    http.end();
  }
  if (f) f.close();

  {
    RecorderLock lock;
    if (remove) {
      recorder.confirmUploaded(uuid);  // borra el .bin y baja el contador
      nextPending = 0;                 // la lista ha cambiado bajo los pies
    } else {
      nextPending++;  // este no sale; que le toque al siguiente
    }
    uploadInFlight = false;
  }
  statusDirty = true;
  return result;
}
