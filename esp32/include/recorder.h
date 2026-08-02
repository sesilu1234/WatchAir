#pragma once
#include <Arduino.h>
#include <SD.h>
#include <vector>

// Formato binario en SD, un fichero por grabación: /rec/<uuid>.bin
//   cabecera (26 B): magic "WAIR"(4) + version(1) + uuid crudo(16) + hz(1)
//                    + started_epoch u32 LE (segundos)
//   registros (6 B): t_ms u32 LE + p_centiPa i16 LE, a 25 Hz
//
// t_ms = epoch_ms_actual − started_epoch*1000. Al salir del reloj real (no de
// millis()), la t es monótona y sobrevive a los reinicios sin corregir nada a
// posteriori: el hueco de un apagón queda como un salto real entre dos
// registros consecutivos, y la gráfica lo pinta con la regla de gaps.
// Debe coincidir con frontend/app/lib/binaryFormat.ts.
//
// /rec/active: contiene solo el uuid de la grabación en curso. Se escribe una
// vez al start y se borra al stop; no se reescribe periódicamente. Todo lo
// demás para reanudar (started_epoch) sale de la cabecera del propio .bin.

constexpr uint16_t SAMPLE_HZ = 25;
constexpr uint32_t LOOP_TIME_MS = 1000 / SAMPLE_HZ;        // 40 ms
constexpr uint32_t RECORDING_MAX_SECONDS = 12UL * 3600UL;  // corte duro a las 12 h

constexpr size_t HEADER_SIZE = 4 + 1 + 16 + 1 + 4;  // 26
constexpr size_t RECORD_SIZE = 6;
constexpr size_t WRITE_BUFFER_RECORDS = 85;  // ~510 B, cerca del bloque de 512 B de la tarjeta

// Lo que debe quedar libre para aceptar un start: 12 h a 25 Hz ≈ 6,5 MB.
constexpr uint64_t REQUIRED_FREE_BYTES =
    (uint64_t)RECORDING_MAX_SECONDS * SAMPLE_HZ * RECORD_SIZE + HEADER_SIZE;

// true cuando NTP ya resolvió la hora real. Sin hora no se graba: la t mentiría.
bool timeIsSynced();

struct PendingUpload {
  String uuid;
  uint32_t size;
};

class Recorder {
 public:
  void begin();  // en setup(), solo si SD.begin() fue bien
  // Reanuda una grabación cortada por un reinicio. Se llama cuando ya hay hora
  // NTP; mientras no la haya no se graba nada.
  void resumeIfPending();

  bool isRecording() const { return recording_; }
  String currentUuid() const { return currentUuid_; }
  uint32_t elapsedSeconds() const;

  // "" si arrancó bien; si no, el motivo, para mandarlo en el ACK.
  const char* start(const String& uuid, bool sensorOk);
  void stop();
  // En el loop de muestreo: sella con el reloj real y corta sola a las 12 h.
  void sample(int16_t pCentiPa);

  // --- subida ---
  std::vector<PendingUpload> listPending();  // /rec/*.bin salvo la que se graba ahora
  uint32_t sizeOf(const String& uuid);
  size_t readChunk(const String& uuid, uint32_t offset, uint8_t* buf, size_t maxLen);
  void confirmUploaded(const String& uuid);  // borra el .bin de la SD

 private:
  // false hasta que begin() confirma que la SD montó; evita tocar SD.* (y el
  // spam de errores del VFS) si la tarjeta nunca llegó a inicializarse.
  bool sdReady_ = false;
  bool recording_ = false;
  String currentUuid_ = "";
  File binFile_;
  uint32_t startedEpoch_ = 0;  // el de la cabecera; define toda la línea de tiempo

  uint8_t writeBuf_[WRITE_BUFFER_RECORDS * RECORD_SIZE];
  size_t writeBufUsed_ = 0;

  static String binPath(const String& uuid) { return "/rec/" + uuid + ".bin"; }
  void flushWriteBuffer();
};

extern Recorder recorder;
