# WatchAir — Grabación autónoma (ESP32 + microSD)

Cambio de arquitectura: **la ESP32 graba en su microSD y el server ya no escribe la señal**.
El wifi pasa a usarse solo para dar órdenes, para mirar en vivo y para subir el fichero al
final. La señal ya no viaja en tiempo real para ser guardada.

**La regla que resuelve todos los conflictos: la fuente de verdad es la ESP32.**
El `recording` del server es una copia cacheada de lo que dijo el aparato la última vez.
Cuando server y ESP32 discrepan, gana la ESP32, siempre, sin excepción. El server nunca
decide por su cuenta que una grabación existe o dejó de existir; solo lo refleja.

---

## 1. RECORDING

### 1.1 El UUID lo genera el server y viaja al aparato

Al pulsar grabar, el server hace el INSERT primero y **le manda el UUID a la ESP32, que
nombra el fichero de la SD con él** (`/rec/<uuid>.bin`).

Esto no es un detalle: es lo que hace que un fichero que llega dos días tarde se sepa a qué
fila pertenece, que subir sea idempotente (reenviar el mismo fichero no duplica nada) y que
el inventario al reconectar (1.6) sea trivial. Sin esto, todo lo demás se complica.

### 1.2 Start

1. Usuario pulsa grabar. UI en loading.
2. Server: comprueba que no hay grabación en curso → INSERT con `started_at = now()` →
   obtiene `<uuid>`. La fila nace en estado **`iniciando`**.
3. Server → ESP32: `{"cmd":"start","id":"<uuid>"}`.
4. ESP32: comprueba precondiciones (1.9) → abre `/rec/<uuid>.bin` → `grabando = true` →
   guarda el marcador de sesión en la SD (1.5).
5. ESP32 → server: `{"ack":"start","id":"<uuid>","rec":true}`.
6. Server: fila a **`grabando`**, `self.recording = <uuid>`, y lo difunde a los frontends.
7. UI: sale del loading y pone "grabando".

**Si el ACK no llega en ~5 s**, el server no borra la fila: la deja en **`iniciando`** y avisa
al usuario de que no se pudo confirmar. Es la diferencia entre "no arrancó" y "no sé si
arrancó", y hay que tratarlas distinto, porque:

**El caso feo: el ACK se pierde pero la ESP32 sí arrancó.** El wifi se cae justo entre el
paso 4 y el 5. La ESP32 está grabando y el server cree que no. Si el server hubiera borrado
la fila, ese fichero llegaría después sin dueño. Como la fila sigue en `iniciando`, el
handshake de reconexión (1.6) la resucita a `grabando` en cuanto el aparato vuelve, y todo
cuadra. **Por eso una fila `iniciando` no se borra nunca automáticamente** — se queda hasta
que se confirma o hasta que el usuario la descarta a mano.

Mientras haya una fila en `iniciando` o `grabando`, no se admite empezar otra.

### 1.3 Stop

1. Usuario pulsa finalizar. UI en loading.
2. Server → ESP32: `{"cmd":"stop","id":"<uuid>"}`.
3. ESP32: cierra el fichero, `grabando = false`, borra el marcador de sesión.
4. ESP32 → server: `{"ack":"stop","id":"<uuid>","rec":false,"samples":N,"bytes":M}`.
5. Server: `ended_at = now()`, `self.recording = None`, fila a **`esperando fichero`**.
   La UI sale del loading **aquí**, no cuando acabe la subida.
6. La subida (1.7) arranca a continuación, con su barra de progreso, y es asunto aparte.

**Parar tiene que ser idempotente.** Mismo problema que en el start: si el stop llega pero
el ACK se pierde, el usuario le va a dar otra vez. Una ESP32 que recibe `stop` sin estar
grabando **no debe responder error**, debe responder el mismo `ack` de siempre con
`rec:false`. Igual con `start`: si llega un `start` con el UUID que ya está grabando, se
responde el ACK y ya, no se abre un fichero nuevo.

Si no hay ESP32, el stop falla y la UI dice que el aparato está desconectado. Aceptado:
para parar hace falta wifi, y la salida cuando no lo hay son las 12 h.

### 1.4 Corte a las 12 h

La ESP32 corta sola a las 12 h, cierra el fichero y lo deja pendiente de subir. Si en ese
momento hay wifi, manda el mismo `ack` de stop que en 1.3 y el server se entera al instante.
Si no lo hay, el server se entera cuando reconecte (1.6).

**El contador de 12 h lo lleva la ESP32, no el server.** Dos temporizadores independientes
acaban discrepando. El server sí puede, pasadas 12 h desde `started_at` sin noticias, marcar
la fila como *probablemente terminada* para no mentir en la UI — pero eso es una suposición,
no un hecho, y `ended_at` queda como **provisional**.

**Cuando llega el fichero, el server corrige `ended_at` y `samples` con lo que diga el
fichero de verdad.** El fichero manda sobre cualquier hora que el server hubiera apuntado a
ojo.

Consecuencia aceptada: si el aparato desaparece, no puedes empezar otra grabación hasta que
vuelva o hasta que pasen las 12 h. Para una grabación por noche es asumible.

### 1.5 Reinicio de la ESP32 a mitad de grabación

Es el único fallo que la SD no resuelve sola, y **con alimentación por USB es un caso real
ya** (un tirón de cable a las 3 AM), no algo que llegue con la batería.

Al arrancar, antes de nada, la ESP32 mira si hay **marcador de sesión** en la SD. Si lo hay,
estaba grabando y no terminó: reabre ese mismo `<uuid>.bin` en modo append y sigue.

El marcador tiene que guardar lo que se pierde al reiniciar:
- el `<uuid>` de la grabación,
- **cuántos ms llevaba grabados** (para que la `t` del fichero siga siendo monotónica y
  relativa al inicio de la grabación, no al arranque de la placa — si no, la `t` salta hacia
  atrás a cero y la gráfica se rompe),
- para saber cuándo se cumplen las 12 h reales.

Como se actualiza a cada rato pero la SD no es infinita, basta con reescribirlo cada N
segundos: pierdes hasta N segundos de precisión en el punto de corte, que es irrelevante.

En el fichero conviene dejar constancia del hueco (un registro marcador, o simplemente el
salto de `t`, ver el criterio de 5-10·L del toDo viejo) para que la gráfica no una dos
tramos separados por dos minutos de nada.

### 1.6 Reconexión: el handshake

Esto pasa a ser la columna vertebral del sistema, no un extra. **Lo primero que hace la
ESP32 al abrir el WS es declarar quién es y qué tiene:**

```json
{"hello": true,
 "rec": "<uuid>" | null,      // qué está grabando ahora mismo, si algo
 "t_ms": 4823100,             // cuánto lleva grabado
 "pending": ["<uuid>", ...]}  // ficheros en la SD sin subir, del más viejo al más nuevo
```

Con eso el server reconstruye su estado entero, y se resuelven de un golpe: server
reiniciado, ESP32 reiniciada, wifi caído seis horas, el ACK perdido de 1.2, y el corte a las
12 h que ocurrió sin testigos. Todo el estado del server es derivable de este mensaje.

Reglas al recibirlo:
- `rec` con un uuid que el server tenía en `iniciando` → pasa a `grabando`. (El caso feo.)
- `rec` con un uuid que el server ya daba por terminado → **gana la ESP32**, se reabre.
- `rec: null` y el server creía que grababa → se cierra la fila; el fichero llegará por
  `pending`.
- Cada uuid de `pending` → se pone en cola de subida (1.7).

### 1.7 Subida del fichero

- **Solo un fichero a la vez, el más viejo primero.** Puede haber varios pendientes (dos
  noches sin wifi).
- **Reanudable por offset.** El server dice cuántos bytes tiene ya de ese uuid y la ESP32
  continúa desde ahí. Con registros de tamaño fijo (1.10) esto es aritmética, no parseo. Sin
  esto, un corte al 90 % de 6 MB te obliga a reenviar los 6 MB.
- **La ESP32 no borra el fichero de la SD hasta que el server confirma** que lo tiene entero
  (tamaño esperado, y a poder ser un checksum). Solo entonces `unlink`.
- Al terminar, el server recalcula `samples` y corrige `ended_at` (1.4) y pasa la fila a
  **`completa`**.
- **No subir mientras se graba** (ver decisiones abiertas): SPI a la SD + wifi + muestreo a
  25 Hz a la vez es la receta para perder muestras, y la grabación en curso es más
  importante que un fichero de anteayer que ya no se va a perder.

### 1.8 Estados de una fila

| Estado | Qué significa | Qué ve el usuario |
|---|---|---|
| `iniciando` | INSERT hecho, sin ACK del aparato | "iniciando…" / "no confirmado" |
| `grabando` | Confirmado por la ESP32 | "grabando · 02:14:33" |
| `esperando fichero` | Terminada, el fichero sigue en la SD | "pendiente de descargar" |
| `subiendo` | Transferencia en curso | barra de progreso, % |
| `completa` | Fichero íntegro en el server | normal |
| `sin fichero` | Terminada y el fichero nunca llegó | "archivo no recibido" |

`sin fichero` **no es definitivo**: si la SD todavía lo tiene, aparecerá en `pending` en
cualquier reconexión futura y la fila se completará sola.

### 1.9 Precondiciones del start

Que fallen tiene que impedir la grabación de forma ruidosa, nunca grabar en el vacío:

- **SD montada y escribible.** Sin SD no hay grabación, punto.
- **Espacio libre** para 12 h (~6,5 MB con el formato de 1.10). Contando lo que ya ocupan
  los ficheros pendientes de subir.
- **Sensor respondiendo** por I2C (una lectura de prueba antes de decir que sí).
- *(Cuando haya batería)* nivel suficiente para la noche.

El ACK del start puede llevar el motivo del fallo para que la UI diga qué pasa en vez de un
error genérico.

### 1.10 Formato del fichero

**Registros de tamaño fijo.** Es lo que hace posible la subida reanudable por offset (1.7),
que el server saque el número de muestras del tamaño del fichero sin parsear nada, y que la
ESP32 escriba sin buffers de longitud variable.

`uint32 t_ms` + `int16 p_centiPa` = **6 bytes/muestra**. A 25 Hz:

- 8 h → 720.000 muestras → **~4,3 MB**
- 12 h → 1.080.000 muestras → **~6,5 MB**

Por wifi de ESP32, eso son entre 10 y 30 segundos de subida reales. De ahí la barra de
progreso en vez de un spinner indeterminado.

Con `t` en delta de 16 bits ocuparía la mitad, pero se pierde el poder saltar a un offset
arbitrario. No compensa por 3 MB.

Una cabecera corta al principio del fichero (magic, versión de formato, uuid, Hz) sale casi
gratis y te ahorra disgustos el día que cambies algo.

---

## 2. LIVE-VIEW

### 2.1 Una sola ruta

Se acabó el visor duplicado. Todo lo de señal en vivo vive en `/realtime`, y el botón "ver"
de la UI de grabación **lleva ahí**, no abre una segunda gráfica.

Si hay grabación en curso, esa misma página cambia un poco: cabecera con "grabando" y el
tiempo transcurrido contando. Misma página, distinto marco. Sigue siendo útil justo durante
la grabación, que es cuando quieres comprobar que la cánula está bien puesta y que la señal
no está muerta.

**No hay botones de start/stop del sensor.** Desaparecen de la UI.

### 2.2 El streaming es estado derivado, no un comando

Entrar en `/realtime` abre el WS. El server cuenta frontends conectados:

- 0 → 1: manda `start` a la ESP32 (empieza a emitir en tiempo real).
- 1 → 0: manda `stop`.

**No hace falta ningún loop de comprobación**: son transiciones, ocurren exactamente en el
connect y el disconnect del WS. Lo único que sí hace falta es reenviar el estado deseado
cuando la ESP32 reconecta, por si se perdió la orden mientras no estaba.

En el firmware quedan **dos flags que no se hablan entre ellos**:

```
muestrea siempre a LOOP_TIME
  if (grabando)  escribe en SD
  if (emitiendo) manda por WS
```

Hoy [main.cpp:101](esp32/src/main.cpp#L101) mezcla las dos cosas en un único `measuring`, y
por eso stop del sensor y stop de grabación se pisan. Separarlos elimina la guarda del 409 y
toda esa clase de bugs de una vez.

### 2.3 Estados de la UI en vivo

Tres estados, no dos. El fallo a evitar es cantar "desconectado" en el cuarto de segundo
normal que pasa entre abrir la página y la primera muestra:

- **Recibiendo datos** → en vivo, pinta.
- **ESP32 conectada pero sin datos aún** (< ~2 s) → "conectando…", no error.
- **Sin datos > ~2 s, o ESP32 no conectada** → "dispositivo desconectado".

Y conviene distinguir **"el navegador perdió el server"** de **"el server no ve la ESP32"**:
son dos fallos distintos y el usuario hace cosas distintas con cada uno.

Caso particular importante: **grabando pero sin wifi**. La página no muestra nada, y eso es
correcto y esperado. Tiene que decir *"grabando · sin conexión con el dispositivo"*, no un
error. La grabación está perfectamente viva en la SD.

### 2.4 Detectar que la ESP32 está viva

`esp32 is not None` solo se vuelve falso cuando el WS se cierra de verdad, y a una ESP32 a
la que le quitas la corriente no le da tiempo a mandar FIN: se queda "conectada" durante
minutos hasta que salta el keepalive de TCP. Sondear cada segundo solo lee más rápido una
variable rancia.

- La señal buena es **frescura**: `last_seen` en el server, conectada = `now - last_seen < 3 s`.
  Con `ws.enableHeartbeat(...)` en el firmware tienes el latido, del lado correcto del cable,
  y de paso la ESP32 detecta un server muerto.
- Y **empujarlo, no sondearlo**: el frontend ya tiene el WS abierto, se difunde el cambio
  cuando cambia. Cero polling.

La card de estado del aparato: online/offline + grabando y cuánto lleva + ficheros
pendientes de subir + *(luego)* batería. Dejar el hueco de la batería desde el principio
aunque de momento ponga "USB" — obliga a pensarla como "estado del aparato" y no como
"¿hay wifi?".

---

## 3. Decisiones abiertas

- **Las 12 h tras un reinicio: ¿se cuentan desde el inicio original o desde el reinicio?**
  Propongo desde el original (por eso el marcador de 1.5 guarda los ms acumulados).
- **¿Se puede empezar una grabación con ficheros pendientes de subir?** Propongo que sí,
  siempre que quede espacio para las 12 h, y que la subida espere a que termine (1.7).
- **¿Se sube algo mientras se graba?** Propongo que no. Si se decide que sí, hay que medir
  qué le hace al muestreo.
- **Descartar a mano una fila `iniciando`** que nunca se confirmó: ¿la borra el usuario desde
  la UI, o caduca sola pasadas las 12 h como el resto?
- **Cuánto se reescribe el marcador de sesión** (1.5): cada 10 s, cada 30 s.

---

## 4. Qué se cae del toDo viejo

Con esta arquitectura dejan de existir, no se arreglan:

- **A1** (el `finally` del WS `/sensor` que mata la grabación): ya no hay nada que matar, la
  grabación no vive en el server.
- **B3** (huecos por desconexión en la gráfica): el fichero está completo por construcción.
  Los únicos huecos posibles son los de 1.5, y esos son reales y hay que pintarlos.
- **D1** (buffer local vs parar al perder wifi): el buffer local **es** la SD.
- **D2** (`millis()` a 0 tras un reset): lo resuelve el marcador de sesión de 1.5.
- **C3 / el 409** (no se puede parar el sensor grabando): al separar los dos flags (2.2), la
  guarda sobra.
- **C4** (`manager.measuring` miente): sustituido por el handshake de 1.6 + frescura de 2.4.

Sigue en pie y sin tocar: **B1/B2** (eje X por `t` y no por índice), **F** (métricas),
**G** (pruebas reales, montaje), **I** (eje Y simétrico, hora de reloj).
