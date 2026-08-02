#pragma once
#include <Arduino.h>
#include <SD.h>
#include <vector>

// Formato binario en SD, un fichero por grabación: /rec/<uuid>.bin
//   cabecera (23 B): magic "WAIR"(4) + version(1) + uuid crudo(16) + hz u16(2)
//   registros (6 B c/u): t_ms u32 LE + p_centiPa i16 LE, a 25 Hz
// Debe coincidir exactamente con frontend/app/lib/binaryFormat.ts.
//
// Sidecar /rec/<uuid>.meta: reconstruye los tramos ("segmentos") que deja
// cada reinicio a mitad de grabación, para poder recalcular sus timestamps
// (relativos a millis() de ESE arranque) a hora real en cuanto hay NTP.
// Un registro de 9 B: tipo(1) + payload(8).
//   SEG    (0): startRecordIndex u32 + millisAtSegmentStart u32
//   ANCHOR (1): epochSecondsAtAnchor u32 + millisAtAnchor u32
//   CORRECTED (2): sin payload (marca que ya se corrigió, evita repetirlo)
//
// /rec/current.uuid: marca la grabación en curso; si existe al arrancar, se
// reanuda (gana la ESP32, es la fuente de verdad). Se borra al parar.

constexpr uint16_t SAMPLE_HZ = 25;
constexpr uint32_t LOOP_TIME_MS = 1000 / SAMPLE_HZ; // 40 ms
constexpr uint32_t RECORDING_CAP_SAMPLES = 12UL * 3600UL * SAMPLE_HZ; // 12 h, sin reloj

constexpr size_t HEADER_SIZE = 4 + 1 + 16 + 2;
constexpr size_t RECORD_SIZE = 6;
constexpr size_t META_RECORD_SIZE = 9;
constexpr size_t WRITE_BUFFER_RECORDS = 85; // ~510 B, cerca del bloque de 512 B que pide la spec

struct PendingUpload {
  String uuid;
  uint32_t size;
};

class Recorder {
 public:
  void begin(); // llamar en setup() solo si SD.begin() ya tuvo éxito
  void onNtpSynced(); // llamar la primera vez que time(nullptr) es válido

  bool isRecording() const { return recording_; }
  String currentUuid() const { return currentUuid_; }

  // true si arrancó bien (crea fichero + cabecera + marcador). false = ya había una.
  bool start(const String& uuid);
  // cierra el fichero pero deja los ficheros en la SD para subir.
  void stop();
  // llamar en el loop de muestreo cuando recording_ es true.
  void sample(uint32_t tMs, int16_t pCentiPa);

  // --- subida ---
  std::vector<PendingUpload> listPending(); // todo lo que hay en /rec/*.bin salvo lo que se está grabando ahora
  // aplica la corrección de timestamps (idempotente) y devuelve el tamaño final del fichero.
  uint32_t prepareForUpload(const String& uuid);
  size_t readChunk(const String& uuid, uint32_t offset, uint8_t* buf, size_t maxLen);
  void confirmUploaded(const String& uuid); // borra .bin/.meta de la SD

 private:
  // false hasta que begin() confirma que la SD montó bien; evita tocar SD.*
  // (y el spam de errores del VFS) si la tarjeta nunca llegó a inicializarse.
  bool sdReady_ = false;
  bool recording_ = false;
  String currentUuid_ = "";
  File binFile_;
  uint32_t sampleCount_ = 0; // se deriva del tamaño del fichero, nunca se persiste aparte

  // Ancla de este arranque: epochSeconds/millis en el instante en que se
  // resolvió NTP. Con eso, cualquier millis() de este mismo arranque se
  // puede pasar a hora real. Una sola vez por arranque, no por grabación.
  bool haveAnchor_ = false;
  uint32_t anchorEpochSeconds_ = 0;
  uint32_t anchorMillis_ = 0;

  uint8_t writeBuf_[WRITE_BUFFER_RECORDS * RECORD_SIZE];
  size_t writeBufUsed_ = 0;

  static String binPath(const String& uuid) { return "/rec/" + uuid + ".bin"; }
  static String metaPath(const String& uuid) { return "/rec/" + uuid + ".meta"; }

  void beginSegment(); // escribe SEG (+ ANCHOR si ya se conoce) en el .meta con el count actual
  void appendMeta(const String& uuid, uint8_t type, uint32_t a, uint32_t b);
  void flushWriteBuffer();
  void writeMarker(const String& uuid);
  void clearMarker();
};

extern Recorder recorder;
