#include "recorder.h"
#include <time.h>

Recorder recorder;

// --- utilidades ---

static void parseUuidBytes(const String& uuid, uint8_t out[16]) {
  int hexIndex = 0;
  uint8_t hi = 0;
  bool haveHi = false;
  for (size_t i = 0; i < uuid.length() && hexIndex < 16; i++) {
    char c = uuid[i];
    uint8_t v;
    if (c >= '0' && c <= '9') v = c - '0';
    else if (c >= 'a' && c <= 'f') v = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') v = c - 'A' + 10;
    else continue; // salta los '-'
    if (!haveHi) {
      hi = v;
      haveHi = true;
    } else {
      out[hexIndex++] = (hi << 4) | v;
      haveHi = false;
    }
  }
}

// --- ciclo de vida ---

void Recorder::begin() {
  sdReady_ = true;
  if (!SD.exists("/rec")) SD.mkdir("/rec");
  if (!SD.exists("/rec/current.uuid")) return;

  File marker = SD.open("/rec/current.uuid", FILE_READ);
  if (!marker) return;
  String uuid = marker.readStringUntil('\n');
  marker.close();
  uuid.trim();
  if (uuid.length() == 0) {
    clearMarker();
    return;
  }

  String path = binPath(uuid);
  if (!SD.exists(path)) {
    // marcador huérfano: sin fichero no hay nada que reanudar
    clearMarker();
    return;
  }

  binFile_ = SD.open(path, FILE_WRITE);
  if (!binFile_) {
    clearMarker();
    return;
  }
  binFile_.seek(binFile_.size()); // por si FILE_WRITE no posiciona al final

  uint32_t size = binFile_.size();
  sampleCount_ = size > HEADER_SIZE ? (size - HEADER_SIZE) / RECORD_SIZE : 0;
  currentUuid_ = uuid;
  recording_ = true;
  writeBufUsed_ = 0;

  beginSegment(); // este arranque es un reinicio a mitad de grabación: nuevo tramo
  Serial.printf("Recorder: reanudando %s en la muestra %u\n", uuid.c_str(), sampleCount_);
}

void Recorder::onNtpSynced() {
  if (haveAnchor_) return;
  haveAnchor_ = true;
  anchorEpochSeconds_ = (uint32_t)time(nullptr);
  anchorMillis_ = millis();
  if (recording_) appendMeta(currentUuid_, 1 /*ANCHOR*/, anchorEpochSeconds_, anchorMillis_);
}

bool Recorder::start(const String& uuid) {
  if (!sdReady_ || recording_) return false;

  File f = SD.open(binPath(uuid), FILE_WRITE);
  if (!f) return false;

  uint8_t header[HEADER_SIZE];
  memcpy(header, "WAIR", 4);
  header[4] = 1; // versión
  uint8_t uuidBytes[16];
  parseUuidBytes(uuid, uuidBytes);
  memcpy(header + 5, uuidBytes, 16);
  header[21] = SAMPLE_HZ & 0xFF;
  header[22] = (SAMPLE_HZ >> 8) & 0xFF;
  f.write(header, HEADER_SIZE);
  f.flush();

  binFile_ = f;
  sampleCount_ = 0;
  currentUuid_ = uuid;
  recording_ = true;
  writeBufUsed_ = 0;

  writeMarker(uuid);
  beginSegment();
  return true;
}

void Recorder::stop() {
  if (!recording_) return;
  flushWriteBuffer();
  binFile_.close();
  clearMarker();
  recording_ = false;
  currentUuid_ = "";
}

void Recorder::sample(uint32_t tMs, int16_t pCentiPa) {
  if (!recording_) return;
  if (sampleCount_ >= RECORDING_CAP_SAMPLES) {
    Serial.println("Recorder: tope de 12h alcanzado, parando sola");
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
  sampleCount_++;

  if (writeBufUsed_ >= sizeof(writeBuf_)) flushWriteBuffer();
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

struct MetaSeg {
  uint32_t startIndex;
  bool hasAnchor = false;
  int64_t k = 0; // anchorEpochSeconds*1000 - anchorMillis, constante del arranque de este tramo
};

// Cota defensiva: cada reinicio con esta grabación en curso añade un SEG al
// .meta. Un bucle de reinicios (crash loop, reflasheos seguidos, etc.) puede
// acumular muchísimos de golpe; sin tope, el vector de abajo puede agotar el
// heap y tirar el firmware justo al intentar subir (visto en producción:
// bad_alloc en prepareForUpload -> abort() -> reboot -> vuelve a crashear con
// el mismo .meta, en bucle infinito). Por encima de esto se renuncia a
// corregir los timestamps de ese tramo, pero el .bin se sube igual.
constexpr size_t MAX_TRACKED_SEGMENTS = 500;

// Recalcula hacia atrás los t_ms de los tramos posteriores a un reinicio,
// para que queden en la misma línea de tiempo que el primer tramo (el que
// no necesita corrección: sus t_ms ya son la referencia). Idempotente: si ya
// se corrigió, no vuelve a tocar el fichero.
uint32_t Recorder::prepareForUpload(const String& uuid) {
  File bin = SD.open(binPath(uuid), FILE_WRITE);
  if (!bin) return 0;
  uint32_t fileSize = bin.size();

  if (!SD.exists(metaPath(uuid))) {
    // grabación de una sola sesión, sin reinicios: nada que corregir
    bin.close();
    return fileSize;
  }

  File meta = SD.open(metaPath(uuid), FILE_READ);
  if (!meta) {
    bin.close();
    return fileSize;
  }

  std::vector<MetaSeg> segs;
  bool alreadyCorrected = false;
  bool overflowed = false;
  uint8_t rec[META_RECORD_SIZE];
  while (meta.readBytes((char*)rec, META_RECORD_SIZE) == META_RECORD_SIZE) {
    uint32_t a, b;
    memcpy(&a, rec + 1, 4);
    memcpy(&b, rec + 5, 4);
    if (rec[0] == 0) { // SEG
      if (segs.size() >= MAX_TRACKED_SEGMENTS) {
        overflowed = true;
        continue; // sigue drenando el fichero, pero ya no trackea más tramos
      }
      MetaSeg seg;
      seg.startIndex = a;
      segs.push_back(seg);
    } else if (rec[0] == 1 && !segs.empty() && !overflowed) { // ANCHOR: del último tramo abierto
      segs.back().hasAnchor = true;
      segs.back().k = (int64_t)a * 1000LL - (int64_t)b;
    } else if (rec[0] == 2) { // CORRECTED
      alreadyCorrected = true;
    }
  }
  meta.close();

  if (alreadyCorrected || segs.empty() || !segs[0].hasAnchor || overflowed) {
    bin.close();
    return fileSize;
  }

  const int64_t k0 = segs[0].k;
  const uint32_t totalSamples = (fileSize - HEADER_SIZE) / RECORD_SIZE;

  for (size_t i = 1; i < segs.size(); i++) {
    if (!segs[i].hasAnchor) continue; // tramo sin NTP en su arranque: se queda sin corregir (caso raro)
    const int64_t delta = segs[i].k - k0;
    const uint32_t startIdx = segs[i].startIndex;
    const uint32_t endIdx = (i + 1 < segs.size()) ? segs[i + 1].startIndex : totalSamples;

    for (uint32_t idx = startIdx; idx < endIdx; idx++) {
      uint32_t offset = HEADER_SIZE + idx * RECORD_SIZE;
      bin.seek(offset);
      uint8_t tbuf[4];
      if (bin.readBytes((char*)tbuf, 4) != 4) break;
      uint32_t rawT;
      memcpy(&rawT, tbuf, 4);
      int64_t corrected = (int64_t)rawT + delta;
      if (corrected < 0) corrected = 0;
      uint32_t newT = (uint32_t)corrected;
      bin.seek(offset);
      bin.write((uint8_t*)&newT, 4);
    }
  }
  bin.flush();
  bin.close();

  appendMeta(uuid, 2 /*CORRECTED*/, 0, 0);
  return fileSize;
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
  SD.remove(metaPath(uuid));
}

// --- internos ---

void Recorder::beginSegment() {
  appendMeta(currentUuid_, 0 /*SEG*/, sampleCount_, millis());
  if (haveAnchor_) appendMeta(currentUuid_, 1 /*ANCHOR*/, anchorEpochSeconds_, anchorMillis_);
}

void Recorder::appendMeta(const String& uuid, uint8_t type, uint32_t a, uint32_t b) {
  File f = SD.open(metaPath(uuid), FILE_WRITE);
  if (!f) return;
  f.seek(f.size());
  uint8_t rec[META_RECORD_SIZE];
  rec[0] = type;
  memcpy(rec + 1, &a, 4);
  memcpy(rec + 5, &b, 4);
  f.write(rec, META_RECORD_SIZE);
  f.close();
}

void Recorder::flushWriteBuffer() {
  if (writeBufUsed_ == 0) return;
  binFile_.write(writeBuf_, writeBufUsed_);
  binFile_.flush();
  writeBufUsed_ = 0;
}

void Recorder::writeMarker(const String& uuid) {
  SD.remove("/rec/current.uuid");
  File f = SD.open("/rec/current.uuid", FILE_WRITE);
  if (!f) return;
  f.print(uuid);
  f.print('\n');
  f.close();
}

void Recorder::clearMarker() {
  if (SD.exists("/rec/current.uuid")) SD.remove("/rec/current.uuid");
}
