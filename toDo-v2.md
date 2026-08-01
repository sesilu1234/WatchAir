# WatchAir — toDo

## La idea en tres frases

La ESP32 graba en su microSD. El server ya no escribe la señal: solo da órdenes, muestra el
directo y recibe el fichero al final. **Cuando server y ESP32 discrepan, gana la ESP32** — el
server solo refleja lo que el aparato dice, nunca decide por su cuenta.

---

## 1. Grabación

### 1.0 El hardware: microSD por SPI

La tarjeta va en un **módulo microSD por SPI** (breakout), no en el bus nativo SD_MMC. Es una
decisión de hardware ya tomada, y condiciona lo demás:

- **Bus propio.** SPI para la SD, I2C para el sensor ([main.cpp:50](esp32/src/main.cpp#L50):
  SDA 4 / SCL 21). Buses distintos, no se pisan. El VSPI por defecto de la ESP32 —SCK 18,
  MISO 19, MOSI 23, **CS 5**— no choca con ninguno de los dos pines del sensor. Nada más
  colgado del SPI: sin más esclavos no hay contención que depurar.
- **Alimentación.** Los módulos con regulador (AMS1117) esperan **5 V por VIN**. Alimentarlos
  desde el 3V3 de la placa los deja por debajo de tensión y da fallos de montaje
  intermitentes, que se leen como "tarjeta mala" sin serlo.
- **Formato.** FAT32; el `SD.h` del core no monta exFAT tal cual. Tarjeta pequeña mejor que
  grande: 12 h son ~6,5 MB, sobra cualquiera, y las grandes solo traen líos de formato.
- **Escribir por bloques, no por muestra.** Cada `flush` cierra sector y cuesta decenas de ms,
  y de vez en cuando la tarjeta se va por encima de 100 ms haciendo su propio *wear-leveling*.
  A 25 Hz el presupuesto por vuelta es 40 ms: escribiendo con el bucle de muestreo bloqueado,
  ese flush largo se come muestras. Acumular ~512 B en RAM (85 muestras ≈ 3,4 s) y volcar de
  golpe, asumiendo perder ese último tramo si se va la corriente.
- **La `t_ms` de cada registro es el seguro** de lo anterior: un flush que se alarga desplaza
  la muestra siguiente, pero el fichero lo dice y la gráfica lo pinta donde toca. Un formato
  sin `t` explícita convertiría cada hipo de la SD en deriva silenciosa.
- **Montar en el `setup()`**, y el fallo es precondición dura (1.7), no aviso. Ojo: sacar la
  tarjeta en caliente no lo detecta nada una vez montada — se ve al escribir.

### 1.1 Ids

- El **server genera el UUID** de la grabación y se lo manda a la ESP32, que nombra el fichero
  `/rec/<uuid>.bin`. Así un fichero que llega dos días tarde sabe a qué fila pertenece y
  reenviarlo no duplica nada.
- Dos ids distintos, que se llamen distinto en el código: `rec_id` (grabación) y `device_id`
  (aparato).

### 1.2 Start — la fila nace del ACK, no del clic

1. Usuario pulsa grabar → UI en loading.
2. Server: comprueba **contra la DB** que no hay ninguna fila en `grabando` → genera `<uuid>`
   → lo guarda en RAM como pendiente (no en DB).
3. Server → ESP32: `{"cmd":"start","id":"<uuid>"}`.
4. ESP32: valida precondiciones (1.7) → abre el fichero → `grabando = true` → escribe el
   marcador de sesión en la SD (1.5).
5. ESP32 → server: `{"ack":"start","id":"<uuid>","rec":true}`.
6. Server: **INSERT** con `started_at`, estado `grabando`, y lo difunde a los frontends.
7. UI sale del loading.

**Sin ACK en ~5 s → no hay fila.** La UI dice que no arrancó y el usuario vuelve a pulsar. No
queda nada que limpiar. **No existe el estado `iniciando`.**

Si el ACK se pierde pero la ESP32 sí estaba grabando, ese fichero es **huérfano y se
descarta**: si al usuario le falló el arranque, ni se puso la cánula.

### 1.3 Stop

1. Server → ESP32: `{"cmd":"stop","id":"<uuid>"}`.
2. ESP32: cierra fichero, `grabando = false`, borra el marcador.
3. ESP32 → server: `{"ack":"stop","id":"<uuid>","rec":false,"samples":N,"bytes":M}`.
4. Server: `ended_at`, fila a `esperando fichero`. **La UI sale del loading aquí**, no al
   acabar la subida.

**Idempotencia (las dos direcciones):**
- `stop` sin estar grabando → responder el ACK normal con `rec:false`, nunca un error.
- `start` con el UUID que ya está grabando → responder ACK, no abrir nada nuevo.
- `start` con un UUID **distinto** → cerrar y borrar el fichero actual y arrancar de cero.

Sin wifi no se puede parar; la salida en ese caso son las 12 h.

### 1.4 Corte a las 12 h

Lo cuenta **la ESP32**, no el server (dos temporizadores acaban discrepando). Corta sola,
cierra el fichero y lo deja pendiente. Si hay wifi manda el mismo ACK de stop; si no, el
server se entera al reconectar (1.6).

El server puede marcar la fila como terminada pasadas 12 h sin noticias, pero ese `ended_at`
es **provisional**: cuando llega el fichero, se corrigen `ended_at` y `samples` con lo que
diga el fichero.

Consecuencia aceptada: si el aparato desaparece, no se puede empezar otra grabación hasta que
vuelva o pasen 12 h.

### 1.5 Reinicio de la ESP32 a mitad de grabación

Un tirón del cable USB a las 3 AM es un caso real hoy. Al arrancar, lo primero: mirar si hay
**marcador de sesión** en la SD. Si lo hay → reabrir ese `<uuid>.bin` en append y seguir.

El marcador guarda: el `<uuid>` y los **ms acumulados** grabados. Los ms son lo importante:
sin ellos la `t` del fichero salta a cero y la gráfica se rompe. También sirven para saber
cuándo se cumplen las 12 h reales.

Se reescribe cada N segundos (no cada muestra: la SD no es infinita). El hueco debe quedar
visible en el fichero para que la gráfica no una dos tramos separados por dos minutos de nada.

### 1.6 Handshake al conectar — la columna vertebral

Primer frame que manda la ESP32 al abrir el WS:

```json
{"hello": true,
 "rec": "<uuid>" | null,      // qué graba ahora mismo
 "t_ms": 4823100,             // cuánto lleva grabado
 "pending": ["<uuid>", ...]}  // ficheros en la SD sin subir, del más viejo al más nuevo
```

Con esto el server reconstruye **todo** su estado: server reiniciado, ESP32 reiniciada, wifi
caído seis horas, ACK perdido, corte a las 12 h sin testigos.

| Qué llega | Qué hace el server |
|---|---|
| `rec` con uuid desconocido | huérfano → `stop` + descartar, no se crea fila |
| `rec` con uuid que daba por terminado | gana la ESP32 → se reabre la fila |
| `rec: null` y el server creía que grababa | cerrar fila; el fichero llegará por `pending` |
| `pending` con fila | a la cola de subida |
| `pending` sin fila | mismo criterio que el huérfano |

Tratarlo como lo que es —el primer frame— con timeout, rechazo de JSON que no cuadre, y sin
dejar sockets a medio identificar en el mapa de conexiones.

### 1.7 Precondiciones del start

Que fallen tiene que impedir la grabación de forma ruidosa, nunca grabar en el vacío:

- SD montada y escribible (`SD.begin(CS)` OK, y una escritura de prueba: montada ≠ viva).
- Espacio para 12 h (~6,5 MB), contando lo que ya ocupan los pendientes.
- Sensor respondiendo por I2C (lectura de prueba).
- *(con batería)* nivel suficiente.

Fallo → mismo ACK con `rec:false` **y el motivo**. El server no hace el INSERT y la UI dice
qué pasó.

### 1.8 Subida del fichero

- Un fichero a la vez, **el más viejo primero**.
- **Reanudable por offset**: el server dice cuántos bytes tiene y la ESP32 sigue desde ahí.
  Con registros de tamaño fijo es aritmética, no parseo.
- La ESP32 **no borra de la SD** hasta que el server confirma que lo tiene entero (tamaño +
  checksum). Solo entonces `unlink`.
- Al terminar: recalcular `samples`, corregir `ended_at`, fila a `completa`.
- **No subir mientras se graba** (SD + wifi + 25 Hz a la vez = muestras perdidas).

### 1.9 Formato del fichero

Cabecera corta (magic, versión, uuid, Hz) + registros de **tamaño fijo**:

`uint32 t_ms` + `int16 p_centiPa` = **6 bytes/muestra** @ 25 Hz → 8 h ≈ 4,3 MB · 12 h ≈ 6,5 MB.

Tamaño fijo es lo que permite la subida reanudable y sacar el nº de muestras del tamaño del
fichero sin parsear. Subir eso son 10–30 s por wifi: barra de progreso, no spinner.

### 1.10 Estados de una fila

| Estado | Significa | UI |
|---|---|---|
| `grabando` | confirmado por la ESP32 (la fila nace aquí) | "grabando · 02:14:33" |
| `esperando fichero` | terminada, el fichero sigue en la SD | "pendiente de descargar" |
| `subiendo` | transferencia en curso | barra de progreso |
| `completa` | fichero íntegro en el server | normal |
| `sin fichero` | terminada y el fichero nunca llegó | "archivo no recibido" |

`sin fichero` no es definitivo: si la SD lo tiene, aparecerá en un `pending` futuro y la fila
se completa sola.

---

## 2. Live-view

### 2.1 Una sola ruta

Todo lo de señal en vivo vive en `/realtime`. El botón "ver" de la lista de grabaciones lleva
ahí; no hay segunda gráfica. Si hay grabación en curso, la misma página añade cabecera de
"grabando" + tiempo transcurrido.

**Desaparecen los botones de start/stop del sensor.**

### 2.2 El streaming es estado derivado

El server cuenta frontends conectados de ese aparato:
- 0 → 1: `start` de emisión a la ESP32.
- 1 → 0: `stop`.

Son transiciones en el connect/disconnect del WS: **cero polling**. Solo hay que reenviar el
estado deseado cuando la ESP32 reconecta.

En el firmware, **dos flags independientes**:

```
muestrea siempre a LOOP_TIME
  if (grabando)  escribe en SD
  if (emitiendo) manda por WS
```

Hoy [main.cpp:101](esp32/src/main.cpp#L101) las mezcla en un único `measuring`; separarlas
elimina el 409 y toda esa clase de bugs.

### 2.3 Estados de la UI

Tres, no dos — el fallo a evitar es cantar "desconectado" en el cuarto de segundo antes de la
primera muestra:

- recibiendo datos → pinta
- conectada, sin datos aún (< ~2 s) → "conectando…"
- sin datos > ~2 s o ESP32 no conectada → "dispositivo desconectado"

Distinguir **"el navegador perdió el server"** de **"el server no ve la ESP32"**.

Caso importante: **grabando pero sin wifi** → *"grabando · sin conexión con el dispositivo"*,
no un error. La grabación está viva en la SD.

### 2.4 Detectar que la ESP32 está viva

`esp32 is not None` miente: a una ESP32 sin corriente no le da tiempo a mandar FIN y se queda
"conectada" minutos. La señal buena es **frescura**: `last_seen`, conectada = `now - last_seen
< 3 s`, con `ws.enableHeartbeat()` en el firmware. Y se **empuja** por el WS al frontend, no
se sondea.

Card de estado del aparato: online/offline · grabando y cuánto lleva · pendientes de subir ·
*(hueco para)* batería.

---

## 3. Auth

### 3.1 El reparto

- **Vercel / Next + NextAuth** → identidad: Google, sesiones, cookies, login.
- **EC2 / FastAPI** → el aparato: WS de la ESP32, ficheros, tiempo real. **Nunca habla con
  Google.**
- Puente: **un secreto compartido y un JWT corto**.

Meter OAuth en la EC2 se descarta a propósito: sería mantener un subsistema de auth casero de
por vida para ahorrar un salto de red.

### 3.2 El token

Next valida la sesión y firma un JWT corto con el secreto compartido. La EC2 solo hace
`jwt.decode` (HMAC, sin red). Claims: cuenta, **aparato al que da acceso**, `exp` corto.

El secreto en env var en los dos lados. **Nunca con prefijo `NEXT_PUBLIC_`.**

| Vía | Cómo viaja |
|---|---|
| WS del live | `/ws?token=...`, validado en el connect |
| POST grabar/parar | `Authorization: Bearer ...` |

**El aparato sale del claim, no de la URL.** Grabar es HTTP y no un mensaje por el WS del
navegador porque es un disparo puntual con respuesta, y el WS del navegador muere al cambiar
de ruta.

### 3.3 El endpoint `/ws`

Un solo endpoint, sin id en la ruta. `dict[device_id, set[WebSocket]]` sustituye a
`manager.frontends`. El `set` resuelve gratis varios navegadores de la misma cuenta, y sus
transiciones 0→1 / 1→0 son las de 2.2, ahora por aparato.

En el connect:
- validar el token antes de dar la conexión por buena;
- token inválido → `accept()` y cerrar con **4401** (un `close()` antes del `accept()` sale
  como 403 y el cliente no distingue caducado de server caído);
- limpieza del set en un `finally`, siempre.

### 3.4 TTL

**El token caduca pero el socket no.** El server guarda el `exp` y cierra la conexión al
cumplirse. El cliente legítimo reconecta solo (mismo `connect()` que ya se reusa al salir de
suspensión); el que entró con un token robado queda fuera.

Toda reconexión pide un token fresco → el endpoint de token es un checkpoint de auth continuo
y una sesión revocada corta el live sin inventar revocación aparte. Cuándo reconectar: por
frescura de datos y eventos `visibilitychange` / `online`.

### 3.5 Qué se toca de lo que ya hay

- [api.ts](frontend/app/lib/api.ts): `WS_FRONTEND_URL` → `/ws?token=...`; `request()` pide el
  token y añade el Bearer.
- [main.py](server/app/main.py): WS `/frontend` → `/ws` con auth; set → dict por aparato; los
  `@app.post` exigen Bearer.
- CORS en la EC2 (el POST viene de Vercel).
- La ESP32 sigue entrando a `/sensor` **sin credencial** — mono-usuario lo aguanta, ver §5.

---

## 4. Decisiones abiertas

| Pregunta | Propuesta |
|---|---|
| ¿12 h desde el inicio original o desde el reinicio? | desde el original (por eso el marcador guarda ms) |
| ¿Grabar con ficheros pendientes de subir? | sí, si hay espacio para 12 h |
| ¿Subir mientras se graba? | no |
| `rec`/`pending` desconocido: ¿borrar al vuelo o purgar por antigüedad? | borrar al vuelo (si no, 12 h grabando en el vacío) |
| ¿Cada cuánto se reescribe el marcador? | 10 s / 30 s |
| ¿Volcado a la SD por bloque o por tiempo? | por bloque de 512 B, midiendo el peor flush real |

---

## 5. Multiusuario (bloquea salir a internet, no bloquea seguir ahora)

- **TLS / `wss://` obligatorio** — hoy el token viaja en claro en la query.
- **Credencial del aparato** — la ESP32 entra a `/sensor` sin identificarse.
- **Provisioning de wifi por aparato**, para no recompilar el firmware por cada casa.

---

## 6. Orden de trabajo

1. **Firmware**: montar la SD por SPI (1.0) y medir cuánto tarda un flush con la tarjeta real;
   separar `grabando` / `emitiendo`, escritura en SD, formato de fichero, marcador de sesión,
   corte a 12 h.
2. **Protocolo**: `hello` + ACKs de start/stop, y el server reconstruyendo estado desde ahí.
3. **DB**: tabla de grabaciones con los 5 estados de 1.10.
4. **Subida**: reanudable por offset, confirmación y `unlink`.
5. **UI**: `/realtime` único, estados de 2.3, card de aparato.
6. **Auth**: NextAuth + Google, endpoint de token, `/ws` y POSTs protegidos.

---

## 7. Qué se cae del toDo viejo

Dejan de existir, no se arreglan: **A1** (el `finally` que mataba la grabación) · **B3**
(huecos por desconexión; los únicos huecos reales son los de 1.5 y hay que pintarlos) ·
**D1** (buffer local = la SD) · **D2** (`millis()` a 0 = marcador de sesión) · **C3/409**
(al separar los flags) · **C4** (`manager.measuring` → handshake + frescura).

Siguen en pie: **B1/B2** (eje X por `t`), **F** (métricas), **G** (pruebas reales, montaje),
**I** (eje Y simétrico, hora de reloj).
