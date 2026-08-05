# WatchAir — decisiones y cambios pendientes


### 1. ACK/NACK y creación de la fila

Se mantiene el NACK explícito tanto para `start_recording` como para
`stop_recording`, pero se quita ACK. y en ambos casos la ESP32 envía un `status` inmediatamente
después para que el server lo reenvíe al frontend y la UI se actualice al
instante.



**Cambio importante:** el INSERT en Supabase ya no se hace al recibir el ACK
de `start_recording`. Se hace al final, cuando la ESP32 ha subido el fichero
al server: en ese momento el server crea la
fila y lo manda a Supabase Storage 

### 2. Tope de 12 h y estado en el frontend

El tope de 12 h se cuenta literalmente desde el inicio de la grabación,
aunque solo se hayan grabado 20 min (11 h 40 desconectada + 20 min grabando).

En el frontend no se deduce nada. Antes se ponía "grabando" dando por hecho
que se había pulsado grabar y que llevaba menos de 12 h. Ahora:

- Sin conexión con la ESP32 → "desconectado". Fin, no se sabe nada más de él.
- Con conexión → se coge tal cual del objeto `status`, que la ESP32 actualiza
  cada poco.

Es decir: no se deduce nada, solo se replica lo que dice el server, que a su
vez lo sabe por el heartbeat de la ESP32.

El nombre de la grabación y su `started_at` salen de la cabecera del fichero
y los da la ESP32 en el status. Y aparecen en cabecera de fichero. No los pone el server con un `datetime.now()` ni nada.

El nombre de la grabacion va ser la fecha de inicio de grabacion (eso lo da la esp32 en el status)

### 4. Signo de la presión

`p = -(-p)` está bien, está a propósito.

### 5. Validar alineación al reanudar

En `resumeIfPending` hay que comprobar `(size - HEADER_SIZE) % RECORD_SIZE == 0`,
porque un flush a medias cuando se apagó la ESP32 deja el resto del fichero
corrupto.

Si no es divisible, truncar los bytes sobrantes y reanudar con normalidad. Si
truncar no es posible, no reanudar: quitar el marcador `active` y dejar el
fichero como pendiente de subir. Se pierde la reanudación, no los datos.

En cualquier caso, **el parser del server tiene que ignorar siempre la cola**:
`n = (len(data) - HEADER_SIZE) // RECORD_SIZE` y descartar el resto. Es una
línea y cubre cualquier fichero cortado, se haya truncado en la ESP32 o no.
### 6. Secretos por aparato

Cada ESP32 debe tener su propio secreto, y en el server pasa a ser
`DEVICE_SECRETS: dict[uuid, secret]`.

### 7. Cable desconectado




- **Error de I2C:** 

El comportamiento actual es correcto: la muestra simplemente no se encola, y
queda un hueco temporal en el fichero. No hacen falta bytes centinela. Lo
único que hay que confirmar es que el frontend lo pinte bien: insertar nulls
cuando el salto supere `GAP_MS = 1000` y usar `connectNulls: false`.

---

## ESP32

### 8. Un único mensaje `status`

Matar `hello`. Un solo mensaje `status`, idéntico al conectar, ante cualquier
cambio y cada 2 s. `sendHello` y `reconcile_hello` desaparecen.

El `status` lo lleva todo, no flags sueltos:

```json
{"type":"status","uuid":"…","boot_id":"…","rec_uuid":null,
 "rec_started_epoch_ms":null,"recording":false,"broadcasting":false,
 "uploading":false,"pending":2,"ntp_ok":true,"t_ms":123456}
```

Incluye `rec_started_epoch_ms`: es el t=0 de la grabación, lo que le da nombre
en la base de datos y en la UI (aunque se identifique por uuid).

**Regla general: el status no toca la SD. Solo refleja variables que ya están
en memoria.**

De ahí salen estas decisiones:

- **Fuera `sd_free_mb`.** `SD.usedBytes()` recorre la FAT y puede tardar
  cientos de ms; cada 2 s desde `netTask` es un desastre. Además no sirve de
  nada: no puedes empezar una grabación sin que el filesystem esté vacío (es
  decir, sin haber subido todo), y si le das a grabar sin espacio el NACK ya
  te lo dice: "imposible grabar, no hay espacio".
- **`pending` no se calcula con `listPending()`**, que abre el directorio y lo
  itera: mismo problema. Contador cacheado en RAM, actualizado en start, stop
  y upload.
- **`t_ms`** es `millis()`, gratis, y sirve para detectar bucles de reinicio.
  Se queda. **`ntp_ok`** también es gratis.
- **`rec_uuid` tiene una trampa:** `currentUuid_` es un `String` y se leería
  desde `netTask` mientras `sdTask` lo modifica. Mantener un
  `char currentUuidStr[37]` que se actualiza bajo candado y se lee suelto,
  en vez de coger el candado como hace `sendHello`: el latido no debe poder
  quedarse esperando a un flush de la SD.

**Flujo desde el frontend:** el usuario está en `/recording` y le da a grabar.
Espera al ACK del server (en verdad espera un status y la UI responde a ello. pero sí es verdad que tiene que haber un NACK, como ya hemos ocmentado). El server
envía instantáneamente el status al frontend, que actualiza la pantalla a
"recording" (quitando opcion de clickar en pantalla startrecording), con el nombre de la grabación (el timestamp), un contador de
tiempo y alguna cosita más bonita si se quiere.


### 9. Subida y broadcast

- **No parar la subida para dar paso a un start.** En la UI aparece la barrita
  de uploading, así que el usuario se entera, y 6,5 MB tardan poco. Abortarla
  me parece peor.
- **`broadcasting = false` al recibir `WStype_DISCONNECTED`**: si no, se sigue
  encolando en `liveQueue` para tirarlas, y no queremos eso.
- **En cuanto se superen las 12 h (o se pare la grabación):** cerrar el
  fichero, actualizar el status a `recording = false`, enviarlo al server, y
  entonces empezar con la subida.

### 10. Un `start_recording` con grabación en curso

No hace falta refactorizar para que solo `sdTask` toque el recorder: quien
recibe el mensaje es `netTask`, y tal como está ahora lo veo bien.

Lo que sí cambia: ahora mismo EN ESP32 está mal porque si llega un start estando grabando, se borra la
grabación actual. Eso no. En `handleServerText`:

```cpp
if (recorder.isRecording()) recorder.stop();   // ← quitar esto
```

En su lugar, avisar de que hay algo grabando : que el server chekee el status de esa esp32 y si esta grabando ya (es decir uuid not none) entonces devuelva al frontend que ya esta grabando

---

## Server

### 11. Reconciliación y estado duplicado

Con el NACK puesto en las acciones de grabación, la reconciliación solo sirve
ya para el broadcast. Renombrar la función a `reconcile_broadcast`: si
`len(browsers) > 0` y `broadcasting` es false, enviar `start_broadcast`; y al
revés si len = 0 entonces broadcasting tiene que ser false

es el unico reconcile que sirve ahora ya y el unico que se queda.




## otros 


12. la ruta de /status es publica y no tiene sentido. quita eso.


13. reaper de 12 h :  no hace ni falta. 
    
AH Y POR CIERTO , uploaded_at es una columna nueva, ASI QUE dame la tabla nueva para pegarlo en supabase 


14. 
cuando recorging upload:
en server : 
Parsear y validar la cabecera.
INSERT de la fila (started_at, ended_at, duration_seconds, file_path, uploaded_at = NULL). Si falla → 503.
Subir el blob a Storage. Si falla → 503, y la fila se queda con uploaded_at NULL.
UPDATE uploaded_at = now(). Si falla → 503.



vale? o sea que : NO SE CREA LA FILA INSERT INTO AL INICIAR LA GRABACION. AHI NO SE HACE NADA DE ESO. ES AL FINAL . TAMPOCO ES CUANDO STOPRECORDING ES SUCCESFULL, SINO QUE CUANDO EL USUARIO SUBE EXITOSAMENTE LA GRABACION AL SERVER


Todo idempotente: el reintento de la ESP32 hace upsert de la fila y upsert del blob, así que repetir es gratis.


15. me han avisado de que :
dev.recording_uuid y dev.recording_now están duplicados y que el now se deduce de uuid
Queda un solo campo, `dev.rec_uuid`, y en el server lo escribe **una sola
línea**: la que procesa el mensaje `status` de la ESP32
(`dev.rec_uuid = data.get("rec_uuid")`). `recordings.start()` solo lo lee para
decidir si manda el comando; `complete_upload()` deja de limpiarlo. El campo
es un espejo de lo que dice la ESP32, no contabilidad propia del server.
## comentario sobre lo del NACK:

16.   puede ser asi :  

No hace falta nada nuevo: ya tienes el mecanismo. Un asyncio.Future con asyncio.wait_for(..., timeout=5) es exactamente eso, y es lo que hace hoy recordings.start. Lo único que cambia es quién llama a set_result: antes el handler de recording_ack, ahora el handler del status.

python
# hub.Device
self.ack: asyncio.Future | None = None   # no es None = hay un comando en vuelo
self.ack_target: str | None = None       # el rec_uuid que esperamos ver

El comando, común a start y stop:

python
async def _command(dev, message: dict, target: str | None):
    dev.ack = asyncio.get_running_loop().create_future()
    dev.ack_target = target
    try:
        if not await dev.send(message):
            raise HTTPException(503, "ESP32 no conectada")
        try:
            ok, reason = await asyncio.wait_for(dev.ack, config.ACK_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise HTTPException(504, "La ESP32 no confirmó a tiempo")
        if not ok:
            raise HTTPException(409, reason)
    finally:
        dev.ack = None
        dev.ack_target = None
start: await _command(dev, {"type": "start_recording", "uuid": rec_uuid}, rec_uuid)
stop: await _command(dev, {"type": "stop_recording"}, None)

Y los dos únicos sitios que lo resuelven:

python

if dev.ack is not None and not dev.ack.done() and data.get("rec_uuid") == dev.ack_target:
    dev.ack.set_result((True, ""))

if dev.ack is not None and not dev.ack.done() and data.get("uuid") == dev.ack_target:
    dev.ack.set_result((False, data.get("reason") or ""))

dev.ack_target vale el uuid nuevo para el start y None para el stop, así que la misma línea sirve para los dos: "espera a que rec_uuid sea X" y "espera a que rec_uuid sea null".

Dos detalles:

El status inmediato no es opcional, es lo que da la latencia. Si la ESP32 solo emitiera cada 2 s, cada grabación tardaría hasta 2 s en confirmarse. Tiene que mandarlo en cuanto cambia el estado. 




17. Otra cosa que tienes que hacer:

`recordings.start` va entero dentro de un `asyncio.Lock` por device
(`dev.command_lock`), y dentro del lock comprueba que el último status diga que
no hay grabación antes de mandar el comando. Si ya está grabando según el
status, no se manda nada a la ESP32 y se devuelve el estado actual: así los
starts que se hubieran encolado esperando el lock se cancelan solos.

`recordings.stop` usa **el mismo lock** (no uno propio) y comprueba lo
contrario: que el status diga que sí hay grabación. Aquí el motivo es otro —
un `stop_recording` duplicado es inofensivo para la ESP32 —, pero sin lock el
segundo POST pisa `dev.ack` y deja al primero esperando un future que ya nadie
resuelve: 5 s colgado y un 504 al usuario aunque la grabación se haya parado
bien.


18. y otro, auqnue ya comentado :

el frontend seimpre se pinta siempre desde el status,




## comentario final

limpia todo lo innecesario, y deja no sobrecargado el codigo...toca las cosas que digo, todas...pero cambio poco mas (solo si ves necesario para que no se rompa el programa y que funcione todo bien)


