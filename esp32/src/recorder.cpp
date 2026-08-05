#include "recorder.h"

#include <sys/time.h>
#include <time.h>
#include <unistd.h>

Recorder recorder;

static const char* ACTIVE_PATH = "/rec/active";
// Prueba de escritura fuera de /rec/ para no ensuciar el directorio de grabaciones.
static const char* SCRATCH_PATH = "/wr_test.tmp";

// La librería SD monta la tarjeta en el VFS bajo este punto (el defecto de
// SD.begin()). Solo hace falta para truncate(), que es POSIX y no pasa por la
// clase File.
static const char* SD_MOUNT_POINT = "/sd";

// --- utilidades ---

bool timeIsSynced() {
  return time(nullptr) > 1700000000;  // fecha "razonable": NTP ya resolvió
}

// El reloj de pared con milisegundos. time(nullptr) da lo mismo truncado al
// segundo, y ese truncado es justo lo que no queremos en el inicio.
static uint64_t epochMillis() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return (uint64_t)tv.tv_sec * 1000ULL + (uint64_t)tv.tv_usec / 1000ULL;
}

static void parseUuidBytes(const String& uuid, uint8_t out[16]) {
  int index = 0;
  uint8_t hi = 0;
  bool haveHi = false;
  for (size_t i = 0; i < uuid.length() && index < 16; i++) {
    char c = uuid[i];
    uint8_t v;
    if (c >= '0' && c <= '9') v = c - '0';
    else if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') v = c - 'A' + 10;
    else continue;  // salta los '-'
    if (!haveHi) {
      hi = v;
      haveHi = true;
    } else {
      out[index++] = (hi << 4) | v;
      haveHi = false;
    }
  }
}

// --- ciclo de vida ---

void Recorder::begin() {
  sdReady_ = true;
  if (!SD.exists("/rec")) SD.mkdir("/rec");
  // Único recorrido del directorio en toda la vida del programa: a partir de
  // aquí el contador se mantiene a mano.
  pendingCount_ = (uint16_t)listPending().size();
}

void Recorder::resumeIfPending() {
  if (!sdReady_ || recording_) return;
  if (!SD.exists(ACTIVE_PATH)) return;
  if (!timeIsSynced()) return;  // sin hora no se puede sellar ninguna muestra

  File marker = SD.open(ACTIVE_PATH, FILE_READ);
  if (!marker) return;
  String uuid = marker.readStringUntil('\n');
  marker.close();
  uuid.trim();
  if (uuid.length() == 0) {
    SD.remove(ACTIVE_PATH);
    return;
  }

  String path = binPath(uuid);
  File f = SD.open(path, FILE_READ);
  if (!f || f.size() < HEADER_SIZE) {  // marcador huérfano: nada que reanudar
    if (f) f.close();
    SD.remove(ACTIVE_PATH);
    return;
  }
  uint8_t header[HEADER_SIZE];
  f.read(header, HEADER_SIZE);
  uint32_t size = f.size();
  f.close();
  if (memcmp(header, "WAIR", 4) != 0) {
    SD.remove(ACTIVE_PATH);
    return;
  }

  uint64_t startedEpochMs;
  memcpy(&startedEpochMs, header + 22, 8);
  uint64_t nowMs = epochMillis();

  if (nowMs < startedEpochMs || nowMs - startedEpochMs >= (uint64_t)RECORDING_MAX_SECONDS * 1000ULL) {
    // se pasó de las 12 h mientras estaba apagada: queda pendiente de subir
    SD.remove(ACTIVE_PATH);
    Serial.printf("Recorder: %s pasó de 12 h estando apagada, queda pendiente\n", uuid.c_str());
    return;
  }

  // Apagarse a mitad de un flush deja un registro cortado al final. Si se
  // reanudara sin más, lo que se escriba a continuación quedaría pegado a esa
  // cola y desplazaría todos los registros nuevos.
  uint32_t extra = (size - HEADER_SIZE) % RECORD_SIZE;
  if (extra != 0) {
    String vfs = String(SD_MOUNT_POINT) + path;
    if (truncate(vfs.c_str(), size - extra) != 0) {
      // Sin truncar no se puede seguir escribiendo en este fichero, pero lo que
      // ya tiene dentro es válido: se deja como pendiente de subir. Se pierde
      // la reanudación, no los datos (el server ignora la cola al parsear).
      SD.remove(ACTIVE_PATH);
      Serial.printf("Recorder: %s desalineado y no se pudo truncar, queda pendiente\n", uuid.c_str());
      return;
    }
    Serial.printf("Recorder: %s desalineado, truncados %u B de cola\n", uuid.c_str(), (unsigned)extra);
  }

  binFile_ = SD.open(path, FILE_APPEND);
  if (!binFile_) {
    SD.remove(ACTIVE_PATH);
    return;
  }
  startedEpochMs_ = startedEpochMs;
  // Lo que la grabación ya llevaba antes de este arranque: el reloj de pared es
  // lo único que lo sabe, porque millis() se fue a cero en el reinicio. A partir
  // de aquí se sigue contando con millis() desde el ancla.
  deltaMs_ = (uint32_t)(nowMs - startedEpochMs);
  anchorMillis_ = millis();
  currentUuid_ = uuid;
  recording_ = true;
  writeBufUsed_ = 0;
  if (pendingCount_ > 0) pendingCount_--;  // deja de estar pendiente: vuelve a ser la activa
  publishSnapshot();
  Serial.printf("Recorder: reanudando %s (%u s ya grabados)\n", uuid.c_str(),
                (unsigned)((nowMs - startedEpochMs) / 1000ULL));
}

const char* Recorder::start(const String& uuid, bool sensorOk) {
  if (recording_) return "ya hay una grabacion en curso";
  if (!sdReady_) return "SD no montada";
  if (!timeIsSynced()) return "sin hora NTP";
  if (!sensorOk) return "sensor no responde";

  // SD realmente escribible (no basta con que montara)
  SD.remove(SCRATCH_PATH);
  File scratch = SD.open(SCRATCH_PATH, FILE_WRITE);
  if (!scratch) return "SD no escribible";
  size_t written = scratch.write((const uint8_t*)"ok", 2);
  scratch.close();
  SD.remove(SCRATCH_PATH);
  if (written != 2) return "SD no escribible";

  // Espacio para 12 h. Lo que ocupan los pendientes ya cuenta como usado.
  if (SD.totalBytes() - SD.usedBytes() < REQUIRED_FREE_BYTES) return "sin espacio para 12 h";

  // Los dos relojes leídos a la vez: este instante es el t=0 de la grabación,
  // dicho en tiempo real (va a la cabecera) y en millis() (el ancla del sellado).
  uint64_t startedEpochMs = epochMillis();
  uint32_t anchorMillis = millis();

  SD.remove(binPath(uuid));  // start con uuid nuevo: siempre de cero
  File f = SD.open(binPath(uuid), FILE_WRITE);
  if (!f) return "no se pudo crear el fichero";

  uint8_t header[HEADER_SIZE];
  memcpy(header, "WAIR", 4);
  header[4] = 3;  // versión 3: started_epoch en ms (la 2 lo tenía en segundos)
  uint8_t uuidBytes[16];
  parseUuidBytes(uuid, uuidBytes);
  memcpy(header + 5, uuidBytes, 16);
  header[21] = (uint8_t)SAMPLE_HZ;
  memcpy(header + 22, &startedEpochMs, 8);
  f.write(header, HEADER_SIZE);
  f.flush();

  binFile_ = f;
  startedEpochMs_ = startedEpochMs;
  anchorMillis_ = anchorMillis;
  deltaMs_ = 0;  // grabación nueva: no lleva nada grabado de antes
  currentUuid_ = uuid;
  recording_ = true;
  writeBufUsed_ = 0;
  publishSnapshot();

  SD.remove(ACTIVE_PATH);
  File marker = SD.open(ACTIVE_PATH, FILE_WRITE);
  if (marker) {
    marker.print(uuid);
    marker.print('\n');
    marker.close();
  }
  return "";
}

void Recorder::stop() {
  if (!recording_) return;
  flushWriteBuffer();
  binFile_.close();
  SD.remove(ACTIVE_PATH);
  recording_ = false;
  currentUuid_ = "";
  startedEpochMs_ = 0;
  anchorMillis_ = 0;
  deltaMs_ = 0;
  pendingCount_++;  // el fichero que se acaba de cerrar entra en la cola de subida
  publishSnapshot();
}

void Recorder::sample(int16_t pCentiPa, uint32_t sampleMillis) {
  if (!recording_) return;

  // Resta con signo para que el wrap de millis() (49,7 días) se resuelva solo.
  // Negativo = la muestra se leyó antes de que esta grabación empezara: es un
  // resto de la anterior que se coló en la cola entre el reset y el arranque.
  int32_t sinceAnchor = (int32_t)(sampleMillis - anchorMillis_);
  if (sinceAnchor < 0) return;

  uint32_t tMs = (uint32_t)sinceAnchor + deltaMs_;
  if (tMs >= RECORDING_MAX_SECONDS * 1000UL) {
    Serial.println("Recorder: tope de 12 h alcanzado, cierro sola");
    stop();
    return;
  }

  size_t o = writeBufUsed_;
  writeBuf_[o + 0] = tMs & 0xFF;
  writeBuf_[o + 1] = (tMs >> 8) & 0xFF;
  writeBuf_[o + 2] = (tMs >> 16) & 0xFF;
  writeBuf_[o + 3] = (tMs >> 24) & 0xFF;
  writeBuf_[o + 4] = pCentiPa & 0xFF;
  writeBuf_[o + 5] = (pCentiPa >> 8) & 0xFF;
  writeBufUsed_ += RECORD_SIZE;

  if (writeBufUsed_ >= sizeof(writeBuf_)) flushWriteBuffer();
}

uint32_t Recorder::elapsedSeconds() const {
  if (!recording_) return 0;
  return (millis() - anchorMillis_ + deltaMs_) / 1000UL;  // igual que las muestras
}

// --- subida ---

std::vector<PendingUpload> Recorder::listPending() {
  std::vector<PendingUpload> out;
  if (!sdReady_) return out;
  File dir = SD.open("/rec");
  if (!dir) return out;

  File entry = dir.openNextFile();
  while (entry) {
    if (!entry.isDirectory()) {
      String name = String(entry.name());
      int slash = name.lastIndexOf('/');
      String base = slash >= 0 ? name.substring(slash + 1) : name;
      if (base.endsWith(".bin")) {
        String uuid = base.substring(0, base.length() - 4);
        if (uuid != currentUuid_) out.push_back({uuid, (uint32_t)entry.size()});
      }
    }
    entry.close();
    entry = dir.openNextFile();
  }
  dir.close();
  return out;
}

File Recorder::openBin(const String& uuid) {
  return SD.open(binPath(uuid), FILE_READ);
}

void Recorder::confirmUploaded(const String& uuid) {
  SD.remove(binPath(uuid));
  if (pendingCount_ > 0) pendingCount_--;
}

// --- internos ---

void Recorder::flushWriteBuffer() {
  if (writeBufUsed_ == 0) return;
  binFile_.write(writeBuf_, writeBufUsed_);
  binFile_.flush();
  writeBufUsed_ = 0;
}

// Ver el comentario de los getters en recorder.h: el orden de escritura es lo
// que hace que un lector sin candado nunca vea un uuid con la fecha de otro.
void Recorder::publishSnapshot() {
  if (recording_) {
    startedEpochMsSnapshot_ = startedEpochMs_;
    strncpy(recUuidSnapshot_, currentUuid_.c_str(), sizeof(recUuidSnapshot_) - 1);
    recUuidSnapshot_[sizeof(recUuidSnapshot_) - 1] = '\0';
  } else {
    recUuidSnapshot_[0] = '\0';
    startedEpochMsSnapshot_ = 0;
  }
}
