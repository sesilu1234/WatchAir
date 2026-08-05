#pragma once
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

// Estado compartido entre las tres tareas (ver main.cpp para el reparto).
//
// Regla única: toda llamada a `recorder` va dentro de un RecorderLock, SALVO los
// tres getters de instantánea (recUuidSnapshot / startedEpochMsSnapshot /
// pendingSnapshot), que existen justo para poder leerse sin candado desde la
// tarea de red. La tarea de muestreo no toca `recorder` nunca — solo encola.
// Así la tarea con deadline real (25 Hz) no puede bloquearse jamás.
//
// Los flags son `volatile bool`: en Xtensa la lectura/escritura de un bool es
// atómica, y cada uno tiene un único escritor, así que no necesitan candado.

extern SemaphoreHandle_t recorderMutex;

extern volatile bool recordingActive;  // escribe: net (start/stop) y sd (corte a 12 h)
extern volatile bool broadcasting;     // escribe: net (start/stop_broadcast, desconexión)
extern volatile bool sensorOk;         // escribe: sampler (última lectura I2C)
extern volatile bool uploadInFlight;   // escribe: sd; lee: net, para NACKear el start

// Identificador de este arranque, para detectar reinicios desde el server. Se
// genera una vez en setup() y viaja en cada `status`.
extern char bootId[9];

// El `status` es el único mensaje de estado que existe: se manda cada 2 s y,
// además, en cuanto algo cambia — que es lo que le da latencia al start/stop
// (el server resuelve el ACK con él, no con un mensaje aparte). Quien cambie
// un estado pone esto a true; la tarea de red lo ve y manda el status.
extern volatile bool statusDirty;

// Vacía la cola de grabación (definida en main.cpp). Se llama al arrancar una
// grabación, con recordingActive ya en false para que nadie esté encolando.
void resetSampleQueue();

// Mutex con herencia de prioridad, así que un start_recording de la tarea de
// red no se queda esperando detrás de un flush de la de SD.
class RecorderLock {
 public:
  RecorderLock() { xSemaphoreTake(recorderMutex, portMAX_DELAY); }
  ~RecorderLock() { xSemaphoreGive(recorderMutex); }
  RecorderLock(const RecorderLock&) = delete;
  RecorderLock& operator=(const RecorderLock&) = delete;
};
