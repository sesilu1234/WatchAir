#pragma once
#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>

// Estado compartido entre las tres tareas (ver main.cpp para el reparto).
//
// Regla única: TODA llamada a `recorder` va dentro de un RecorderLock. La tarea
// de muestreo es la excepción y por eso no toca `recorder` nunca — solo encola.
// Así la tarea con deadline real (25 Hz) no puede bloquearse jamás.
//
// Los flags son `volatile bool`: en Xtensa la lectura/escritura de un bool es
// atómica, y cada uno tiene un único escritor, así que no necesitan candado.

extern SemaphoreHandle_t recorderMutex;

extern volatile bool recordingActive;  // escribe: net (start/stop) y sd (corte a 12 h)
extern volatile bool broadcasting;     // escribe: net (start/stop_broadcast)
extern volatile bool sensorOk;         // escribe: sampler (última lectura I2C)
extern volatile bool uploadInFlight;   // escribe: sd; lee: net, para NACKear el start

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
