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

// true si subió (y borró) una; false si no había nada que subir o falló.
bool uploadNextPending();
