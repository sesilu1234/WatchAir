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

Al pulsar grabar, el server genera el UUID y **se lo manda a la ESP32, que nombra el fichero
de la SD con él** (`/rec/<uuid>.bin`). El INSERT en la DB no va aquí: va después, cuando
llegue el ACK (1.2).

Esto no es un detalle: es lo que hace que un fichero que llega dos días tarde se sepa a qué
fila pertenece, que subir sea idempotente (reenviar el mismo fichero no duplica nada) y que
el inventario al reconectar (1.6) sea trivial. Sin esto, todo lo demás se complica.

### 1.2 Start: la fila nace del ACK, no del clic

**El flujo va al revés de lo que parece natural: la fila en la DB no existe hasta que la
ESP32 confirma que está grabando.**

1. Usuario pulsa grabar. UI en loading.
2. Server: comprueba que no hay grabación en curso → genera `<uuid>` → lo guarda como
   **start pendiente en una variable en RAM**, no en la DB.
3. Server → ESP32: `{"cmd":"start","id":"<uuid>"}` por el WS del aparato.
4. ESP32: comprueba precondiciones (1.9) → abre `/rec/<uuid>.bin` → `grabando = true` →
   guarda el marcador de sesión en la SD (1.5).
5. ESP32 → server: `{"ack":"start","id":"<uuid>","rec":true}`.
6. Server: **INSERT** con `started_at`, `self.recording = <uuid>`, tira el pendiente de la
   RAM y lo difunde a los frontends. La fila nace directamente en **`grabando`**.
7. UI: sale del loading y pone "grabando".

**Si el ACK no llega en ~5 s**, no hay fila. La UI dice que no se pudo arrancar y ya está: no
queda rastro en la DB, no hay nada que limpiar después, y el usuario vuelve a pulsar.

**El caso feo, y por qué ahora da igual.** El wifi se cae justo entre el paso 4 y el 5: la
ESP32 está grabando y el server no tiene fila. Antes eso obligaba a inventar un estado
`iniciando` que no se podía borrar nunca. Ahora esa grabación es **huérfana y se descarta**:
si el arranque le falló al usuario, el usuario ni se puso la cánula, así que en ese fichero
no hay señal que perder. Se tira un fichero de ruido, no una noche de datos.

**Re-pulsar es la vía de salida.** El server genera un `<uuid>` nuevo y manda otro `start`.
La ESP32, al recibir un `start` con un id distinto del que tiene abierto, **cierra y borra el
suyo y arranca de cero**. No necesita saber si su grabación estaba confirmada o no: la guarda
vive en el server, que no manda un segundo `start` mientras tenga una fila en `grabando` — y
esa comprobación va **contra la DB, no contra la RAM**, para que sobreviva a un reinicio del
server.

**Esto elimina el estado `iniciando`.** Solo hay filas de grabaciones que existieron de
verdad.

Mientras haya una fila en `grabando`, no se admite empezar otra.

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
responde el ACK y ya, no se abre un fichero nuevo. (Un `start` con un UUID **distinto** es
otra cosa: ese es el re-pulsar de 1.2, y ahí sí se descarta el fichero abierto.)

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
- `rec` con un uuid **que el server no conoce** → es el huérfano de 1.2 (el ACK que se
  perdió). No se crea fila: se manda `stop` y se descarta. (Ver §4.)
- `rec` con un uuid que el server ya daba por terminado → **gana la ESP32**, se reabre.
- `rec: null` y el server creía que grababa → se cierra la fila; el fichero llegará por
  `pending`.
- Cada uuid de `pending` **con fila** → se pone en cola de subida (1.7). Sin fila, mismo
  criterio que el huérfano.

**El `hello` es el primer frame del socket, y hay que tratarlo como tal:** acotarlo con un
timeout, rechazar un frame binario o un JSON que no cuadre, y aguantar una desconexión a
media identificación. Un socket a medio identificar no puede quedarse en el mapa de
conexiones.

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
| `grabando` | Confirmado por la ESP32 (la fila nace aquí) | "grabando · 02:14:33" |
| `esperando fichero` | Terminada, el fichero sigue en la SD | "pendiente de descargar" |
| `subiendo` | Transferencia en curso | barra de progreso, % |
| `completa` | Fichero íntegro en el server | normal |
| `sin fichero` | Terminada y el fichero nunca llegó | "archivo no recibido" |

`sin fichero` **no es definitivo**: si la SD todavía lo tiene, aparecerá en `pending` en
cualquier reconexión futura y la fila se completará sola.

**No hay estado `iniciando`**: un start sin confirmar no llega a ser una fila (1.2).

### 1.9 Precondiciones del start

Que fallen tiene que impedir la grabación de forma ruidosa, nunca grabar en el vacío:

- **SD montada y escribible.** Sin SD no hay grabación, punto.
- **Espacio libre** para 12 h (~6,5 MB con el formato de 1.10). Contando lo que ya ocupan
  los ficheros pendientes de subir.
- **Sensor respondiendo** por I2C (una lectura de prueba antes de decir que sí).
- *(Cuando haya batería)* nivel suficiente para la noche.

Una precondición que falla se responde con el mismo ACK pero `rec:false` y el motivo: el
server **no hace el INSERT** y la UI dice qué pasó en vez de un error genérico. Es la única
diferencia práctica entre "falló" y "no contestó" (1.2), y desde fuera se ven igual salvo por
ese motivo.

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

Entrar en `/realtime` abre el WS (autenticado, y con el aparato sacado del token: 3.4). El
server cuenta frontends conectados **de ese aparato**:

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

## 3. Auth y reparto de servidores

Hasta ahora el frontend hablaba con la EC2 sin que nadie preguntase quién era. Eso se acaba:
**la app pide login**, y para sostenerlo aparece una segunda pieza de servidor.

### 3.1 La frontera: "quién eres" vs "qué hace el aparato"

- **Vercel / Next** (el [frontend/](frontend/) de hoy, más NextAuth) se queda con la
  identidad: Google, sesiones, cookies, pantalla de login. Es su idioma nativo.
- **EC2 / FastAPI** se queda con el aparato: WS de la ESP32, muestreo, ficheros, tiempo real.
  **La EC2 nunca habla con Google.**
- El puente entre las dos es **un secreto compartido y un JWT corto**.

Meter OAuth directamente en la EC2 para ahorrarse el trayecto se descarta a propósito: parece
lo profesional y es justo lo contrario — adoptas un subsistema de auth casero, y lo mantienes
de por vida, a cambio de ahorrar un salto de red de milisegundos.

### 3.2 Un solo modelo de token

Next valida la sesión y **acuña un JWT corto firmado con el secreto compartido**. La EC2 solo
hace `jwt.decode`: verificación HMAC de microsegundos, sin red y sin depender de Google. Si
Google se cae, el live sigue vivo hasta que caduque el token.

Claims mínimos: la cuenta, **el aparato al que da acceso**, y un `exp` corto.

El secreto va como variable de entorno en los dos lados. **Nunca con prefijo
`NEXT_PUBLIC_`**: eso lo hornea en el bundle del navegador y regalas la capacidad de firmar
tokens.

### 3.3 Las dos vías que usan ese token

Un token, dos usos, para no inventar dos caminos de auth:

| Vía | Cómo viaja |
|---|---|
| WS del live | query param: `/ws?token=...`, validado en el connect |
| POST de grabar / parar | header `Authorization: Bearer ...`, directo del navegador a la EC2 |

**El aparato sale del claim del token, no de la URL.** Es la diferencia entre identificarse y
decir un número: un id inventado no entra al mapa de viewers porque, sin firma válida, ni se
llega a leer.

El token en la query acaba en los logs de acceso y en cualquier proxy que haya por el medio.
Por eso vive poco (3.5) y por eso `wss://` deja de ser opcional en cuanto esto salga a
internet (§4).

**Por qué "grabar" es HTTP y no un mensaje por el WS del navegador:** es un disparo puntual
con respuesta (arrancó / no arrancó, y por qué), que es exactamente la forma de una petición
HTTP; y además el WS del navegador se muere al cambiar de ruta, así que no puedes colgar de
él una acción que tiene que sobrevivir a una navegación. El navegador hace el POST y el
server lo traduce a `{"cmd":"start"}` sobre el WS de la ESP32, que es la única vía al aparato
y siempre lo fue.

### 3.4 El endpoint `/ws`

Un solo endpoint, **sin id en la ruta**. Los viewers se guardan en un
`dict[device_id, set[WebSocket]]` que sustituye al `manager.frontends` de hoy
([main.py:148](server/app/main.py#L148)).

> Cuidado con el nombre: en el resto de este documento `<uuid>` es el id de una **grabación**.
> El de aquí es el id del **aparato**. Son cosas distintas y conviene que se llamen distinto
> en el código (`device_id` vs `rec_id`).

Buscar es O(1), el `set` resuelve gratis varios navegadores de la misma cuenta, y sus
transiciones **0→1 / 1→0** son las que disparan el start/stop de emisión de 2.2 — ahora por
aparato, no globales.

En el connect:

- Validar el token **antes de dar la conexión por buena**. Cuesta microsegundos, y la
  consulta de "¿este aparato es de esta cuenta?" es un `await` que no bloquea el bucle de
  muestras.
- Token inválido → cerrar con **4401**. Detalle práctico de Starlette: para que el navegador
  llegue a ver ese código hay que `accept()` y cerrar acto seguido; un `close()` *antes* del
  `accept()` sale como un 403 del handshake y el cliente solo ve "falló", sin poder
  distinguir token caducado de server caído.
- La limpieza del set, en un `finally`. Siempre, y pase lo que pase.

### 3.5 TTL de conexión

**El token caduca pero el socket no.** Un socket abierto con un token robado seguiría vivo
para siempre. Así que el server se guarda el `exp` del claim y **cierra la conexión cuando se
cumple**.

El cliente legítimo reconecta solo: es el mismo `connect()` que ya se reusa para cuando el
portátil sale de suspensión
([useFrontendSocket.ts:32](frontend/app/lib/useFrontendSocket.ts#L32)). El que entró con un
token robado es expulsado y no puede volver sin conseguir otro válido.

### 3.6 Reconexión del navegador

**Toda reconexión pasa por pedir un token fresco**, y eso convierte al endpoint de token en
un checkpoint de auth continuo: una sesión revocada corta el live en el primer reintento, sin
inventar ningún mecanismo de revocación aparte.

Cuándo reconectar sigue el criterio de 2.4: **frescura de los datos** y los eventos
`visibilitychange` / `online`, no esperar a que el TCP se entere.

### 3.7 Qué toca cambiar de lo que ya hay

- [api.ts](frontend/app/lib/api.ts): `WS_FRONTEND_URL` (`/frontend`) pasa a `/ws?token=...`,
  y `request()` tiene que pedir el token y meter el `Authorization: Bearer`.
- [main.py:352](server/app/main.py#L352): el WS `/frontend` pasa a `/ws` con auth, y el set
  pasa a dict por aparato.
- Los `@app.post` de comandos pasan a exigir el Bearer.
- CORS en la EC2: el POST sale de un origen (Vercel) distinto al de la API.
- **La ESP32 sigue entrando a `/sensor` sin credencial.** En mono-usuario pasa; es la pieza
  que falta, y está en §4.

---

## 4. Decisiones abiertas

- **Las 12 h tras un reinicio: ¿se cuentan desde el inicio original o desde el reinicio?**
  Propongo desde el original (por eso el marcador de 1.5 guarda los ms acumulados).
- **¿Se puede empezar una grabación con ficheros pendientes de subir?** Propongo que sí,
  siempre que quede espacio para las 12 h, y que la subida espere a que termine (1.7).
- **¿Se sube algo mientras se graba?** Propongo que no. Si se decide que sí, hay que medir
  qué le hace al muestreo.
- **El `rec` / `pending` desconocido del handshake** (1.6): ¿el server manda borrarlo al
  vuelo, o lo deja en la SD y se purga por antigüedad? Propongo borrarlo al vuelo — si no,
  una ESP32 con el ACK perdido se pasa 12 h grabando en el vacío y llenando la tarjeta.
- **Cuánto se reescribe el marcador de sesión** (1.5): cada 10 s, cada 30 s.

**Para cuando toque multiusuario de verdad.** Nada de esto bloquea seguir en mono-usuario,
pero sí bloquea que datos de otra persona viajen por internet:

- **TLS / `wss://` obligatorio.** Hoy el token viaja en claro en la query.
- **Credencial del aparato**: la ESP32 entra a `/sensor` sin identificarse (3.7).
- **Provisioning de wifi por aparato**, para no recompilar el firmware por cada casa.

---

## 5. Qué se cae del toDo viejo

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
