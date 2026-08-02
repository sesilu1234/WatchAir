#include "recorder.h"

#include <sys/time.h>
#include <time.h>

Recorder recorder;

static const char* ACTIVE_PATH = "/rec/active";
// Prueba de escritura fuera de /rec/ para no ensuciar el directorio de grabaciones.
static const char* SCRATCH_PATH = "/wr_test.tmp";

// --- utilidades ---

bool timeIsSynced() {
  return time(nullptr) > 1700000000;  // fecha "razonable": NTP ya resolvió
}

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
  f.close();
  if (memcmp(header, "WAIR", 4) != 0) {
    SD.remove(ACTIVE_PATH);
    return;
  }

  uint32_t startedEpoch;
  memcpy(&startedEpoch, header + 22, 4);
  uint32_t now = (uint32_t)time(nullptr);

  if (now < startedEpoch || now - startedEpoch >= RECORDING_MAX_SECONDS) {
    // se pasó de las 12 h mientras estaba apagada: queda pendiente de subir
    SD.remove(ACTIVE_PATH);
    Serial.printf("Recorder: %s pasó de 12 h estando apagada, queda pendiente\n", uuid.c_str());
    return;
  }

  binFile_ = SD.open(path, FILE_APPEND);
  if (!binFile_) {
    SD.remove(ACTIVE_PATH);
    return;
  }
  startedEpoch_ = startedEpoch;
  currentUuid_ = uuid;
  recording_ = true;
  writeBufUsed_ = 0;
  Serial.printf("Recorder: reanudando %s (%u s ya grabados)\n", uuid.c_str(),
                (unsigned)(now - startedEpoch));
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

  uint32_t startedEpoch = (uint32_t)time(nullptr);

  SD.remove(binPath(uuid));  // start con uuid nuevo: siempre de cero
  File f = SD.open(binPath(uuid), FILE_WRITE);
  if (!f) return "no se pudo crear el fichero";

  uint8_t header[HEADER_SIZE];
  memcpy(header, "WAIR", 4);
  header[4] = 2;  // versión 2: cabecera con started_epoch
  uint8_t uuidBytes[16];
  parseUuidBytes(uuid, uuidBytes);
  memcpy(header + 5, uuidBytes, 16);
  header[21] = (uint8_t)SAMPLE_HZ;
  memcpy(header + 22, &startedEpoch, 4);
  f.write(header, HEADER_SIZE);
  f.flush();

  binFile_ = f;
  startedEpoch_ = startedEpoch;
  currentUuid_ = uuid;
  recording_ = true;
  writeBufUsed_ = 0;

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
  startedEpoch_ = 0;
}

void Recorder::sample(int16_t pCentiPa) {
  if (!recording_) return;

  uint64_t startMs = (uint64_t)startedEpoch_ * 1000ULL;
  uint64_t nowMs = epochMillis();
  if (nowMs < startMs) return;  // reloj hacia atrás: se descarta la muestra

  uint64_t elapsed = nowMs - startMs;
  if (elapsed >= (uint64_t)RECORDING_MAX_SECONDS * 1000ULL) {
    Serial.println("Recorder: tope de 12 h alcanzado, cierro sola");
    stop();
    return;
  }
  uint32_t tMs = (uint32_t)elapsed;

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
  uint32_t now = (uint32_t)time(nullptr);
  return now > startedEpoch_ ? now - startedEpoch_ : 0;
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

uint32_t Recorder::sizeOf(const String& uuid) {
  File f = SD.open(binPath(uuid), FILE_READ);
  if (!f) return 0;
  uint32_t size = f.size();
  f.close();
  return size;
}

size_t Recorder::readChunk(const String& uuid, uint32_t offset, uint8_t* buf, size_t maxLen) {
  File f = SD.open(binPath(uuid), FILE_READ);
  if (!f) return 0;
  f.seek(offset);
  size_t n = f.readBytes((char*)buf, maxLen);
  f.close();
  return n;
}

void Recorder::confirmUploaded(const String& uuid) {
  SD.remove(binPath(uuid));
}

// --- internos ---

void Recorder::flushWriteBuffer() {
  if (writeBufUsed_ == 0) return;
  binFile_.write(writeBuf_, writeBufUsed_);
  binFile_.flush();
  writeBufUsed_ = 0;
}
