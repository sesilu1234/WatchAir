#pragma once
#include <Arduino.h>
#include <SD.h>
#include <vector>

// Formato binario en SD, un fichero por grabación: /rec/<uuid>.bin
//   cabecera (30 B): magic "WAIR"(4) + version(1) + uuid crudo(16) + hz(1)
//                    + started_epoch_ms u64 LE (ms desde 1970)
//   registros (6 B): t_ms u32 LE + p_centiPa i16 LE, a 25 Hz
//
// El inicio va en ms, no en segundos, para que el t=0 del fichero sea un
// instante exacto: con segundos truncados habría hasta 999 ms de desfase entre
// lo que dice la cabecera y el origen contra el que se sellan las muestras.
// Esa cabecera es también la que da nombre y `started_at` a la grabación en la
// base de datos: el server los saca de aquí, nunca de un datetime.now().
//
// t_ms = ms desde ese inicio, sellados en el instante en que el sensor devolvió
// la muestra (no cuando se escribe: entre una cosa y otra hay cola, mutex y
// flushes a SD, y ese retardo es variable). El hueco de un apagón queda como un
// salto real entre dos registros consecutivos, y la gráfica lo pinta con la
// regla de gaps. Debe coincidir con frontend/app/lib/binaryFormat.ts.
//
// /rec/active: contiene solo el uuid de la grabación en curso. Se escribe una
// vez al start y se borra al stop; no se reescribe periódicamente. Todo lo
// demás para reanudar (started_epoch) sale de la cabecera del propio .bin.

constexpr uint16_t SAMPLE_HZ = 25;
constexpr uint32_t LOOP_TIME_MS = 1000 / SAMPLE_HZ;        // 40 ms
constexpr uint32_t RECORDING_MAX_SECONDS = 12UL * 3600UL;  // corte duro a las 12 h

constexpr size_t HEADER_SIZE = 4 + 1 + 16 + 1 + 8;  // 30
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

  // "" si arrancó bien; si no, el motivo, para mandarlo en el NACK.
  const char* start(const String& uuid, bool sensorOk);
  void stop();
  // `sampleMillis` es el millis() del instante en que se leyó el sensor, no el
  // de ahora: lo trae la muestra desde la tarea de muestreo. Corta sola a las 12 h.
  void sample(int16_t pCentiPa, uint32_t sampleMillis);

  // --- instantánea para el `status` -----------------------------------------
  //
  // El status sale cada 2 s desde la tarea de red y NO puede tocar la SD ni
  // esperar al candado: un flush lento dejaría el latido colgado. Estas tres
  // copias se escriben bajo el candado (junto al estado que reflejan) y se leen
  // sueltas desde fuera.
  //
  // El orden de escritura importa: al arrancar se pone la fecha antes que el
  // uuid, y al parar se borra el uuid antes que la fecha, así que quien lea un
  // uuid no vacío ve siempre su fecha ya puesta.
  const char* recUuidSnapshot() const { return recUuidSnapshot_; }  // "" = no se graba
  uint64_t startedEpochMsSnapshot() const { return startedEpochMsSnapshot_; }
  uint16_t pendingSnapshot() const { return pendingCount_; }

  // --- subida ---
  std::vector<PendingUpload> listPending();  // /rec/*.bin salvo la que se graba ahora
  // Handle abierto para que HTTPClient lo streamee tal cual (File es un Stream).
  // Un solo open por subida, no uno por trozo. Devuelve un File falsy si no está.
  File openBin(const String& uuid);
  void confirmUploaded(const String& uuid);  // borra el .bin de la SD

 private:
  // false hasta que begin() confirma que la SD montó; evita tocar SD.* (y el
  // spam de errores del VFS) si la tarjeta nunca llegó a inicializarse.
  bool sdReady_ = false;
  bool recording_ = false;
  String currentUuid_ = "";
  File binFile_;
  uint64_t startedEpochMs_ = 0;  // el de la cabecera; define toda la línea de tiempo
  // El millis() de cuando esta tanda de grabación empezó a correr, y lo que ya
  // llevaba grabado la grabación en ese momento (0 si es nueva; las horas que
  // lleve viva si se está reanudando tras un reinicio).
  //
  //   t_ms de la muestra = (millis de la muestra − anchorMillis_) + deltaMs_
  //
  // Los dos se fijan una sola vez, al arrancar o al reanudar. A partir de ahí el
  // sellado no vuelve a mirar el reloj de pared, así que los steps de SNTP (que
  // los hay, ~1/h y a saltos) no entran en la t.
  uint32_t anchorMillis_ = 0;
  uint32_t deltaMs_ = 0;

  // Ficheros en /rec que no son el que se graba ahora. Contador en RAM y no un
  // listPending() por cada status: abrir e iterar el directorio cuesta cientos
  // de ms en una tarjeta lenta. Se cuenta una vez en begin() y a partir de ahí
  // lo mueven start/stop/resume/confirmUploaded.
  uint16_t pendingCount_ = 0;

  char recUuidSnapshot_[37] = "";
  volatile uint64_t startedEpochMsSnapshot_ = 0;

  uint8_t writeBuf_[WRITE_BUFFER_RECORDS * RECORD_SIZE];
  size_t writeBufUsed_ = 0;

  static String binPath(const String& uuid) { return "/rec/" + uuid + ".bin"; }
  void flushWriteBuffer();
  void publishSnapshot();  // vuelca currentUuid_/startedEpochMs_ a las copias
};

extern Recorder recorder;
