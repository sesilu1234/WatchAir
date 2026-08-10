#pragma once
#include <Arduino.h>

// Subida de una grabación al servidor: un POST con el fichero entero.
//
// No hay reanudación, ni offsets, ni checksum, a propósito. El fichero cabe de
// sobra en una petición (12 h a 25 Hz ≈ 6,5 MB) y la copia de la SD no se borra
// hasta ver un 200, así que un fallo a mitad no pierde nada: se reintenta la
// subida entera. Reanudar costaba releer el prefijo de la SD para el CRC, que
// es casi tan caro como volver a mandarlo.
//
// Se llama desde la tarea de SD, que es la única dueña de la tarjeta y puede
// bloquearse todo lo que haga falta sin afectar al muestreo ni al heartbeat.

// Cómo acabó el intento. Son tres y no dos porque quien llama espacia los
// reintentos cuando fallan, y "no había nada que subir" no es un fallo: con un
// solo booleano, estar sin WiFi un rato acababa retrasando la primera subida
// buena en cuanto volviera la red.
enum class UploadResult {
  Idle,      // no tocaba: sin WiFi, grabando, o nada pendiente
  Progress,  // la cola tiene un fichero menos (subido, o descartado por el server)
  Failed,    // se intentó y salió mal; conviene esperar más antes de repetir
};

UploadResult uploadNextPending();
