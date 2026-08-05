# WatchAir — decisiones y cambios pendientes

## General

### 1. ACK/NACK y creación de la fila

Se mantiene el ACK/NACK explícito tanto para `start_recording` como para
`stop_recording`, y en ambos casos la ESP32 envía un `status` inmediatamente
después para que el server lo reenvíe al frontend y la UI se actualice al
instante.



**Cambio importante:** el INSERT en Supabase ya no se hace al recibir el ACK
de `start_recording`. Se hace al final, cuando la ESP32 ha subido el fichero
al server: en ese momento el server lo manda a Supabase Storage y crea la
fila.

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
y los da la ESP32 en el ACK. No los pone el server con un `datetime.now()`.


### 4. Signo de la presión

`p = -(-p)` está bien, está a propósito.

### 5. Validar alineación al reanudar

En `resumeIfPending` hay que comprobar `(size - HEADER_SIZE) % RECORD_SIZE == 0`,
porque un flush a medias cuando se apagó la ESP32 deja el resto del fichero
corrupto. Si no es divisible: validar y **truncar** los bytes sobrantes si se
puede; si realmente está corrupto, ajo y agua.



### 6. Secretos por aparato

Cada ESP32 debe tener su propio secreto, y en el server pasa a ser
`DEVICE_SECRETS: dict[uuid, secret]`.

### 7. Cable desconectado

Son dos cosas distintas:


- **Error de I2C:** ahí sí se puede considerar la muestra nula.

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
Espera al ACK del server, que a su vez espera al ACK de la ESP32. El server
envía instantáneamente el status al frontend, que actualiza la pantalla a
"recording", con el nombre de la grabación (el timestamp), un contador de
tiempo y alguna cosita más bonita si se quiere.

**El ACK de `start_recording` se queda**, no lo veo claro de otra forma. Y
debe haber también ACK de `stop_recording`: la ESP32 cierra el fichero, pone
`recording = false`, borra el marcador `active` y manda el ACK (que supongo
que es simplemente un status); acto seguido se pone a subir la grabación.

### 9. Subida y broadcast

- **No parar la subida para dar paso a un start.** En la UI aparece la barrita
  de uploading, así que el usuario se entera, y 6,5 MB tardan poco. Abortarla
  me parece peor.
- **`broadcasting = false` al recibir `WStype_DISCONNECTED`**: si no, se sigue
  encolando en `liveQueue` para tirarlas.
- **En cuanto se superen las 12 h (o se pare la grabación):** cerrar el
  fichero, actualizar el status a `recording = false`, enviarlo al server, y
  entonces empezar con la subida.

### 10. Un `start_recording` con grabación en curso

No hace falta refactorizar para que solo `sdTask` toque el recorder: quien
recibe el mensaje es `netTask`, y tal como está ahora lo veo bien.

Lo que sí cambia: ahora mismo está mal porque si llega un start estando grabando, se borra la
grabación actual. Eso no. En `handleServerText`:

```cpp
if (recorder.isRecording()) recorder.stop();   // ← quitar esto
```

En su lugar, avisar de que hay algo grabando; que el usuario la pare si quiere
y vuelva a grabar. O quizas que mande un simple ok y ya, lo que prefieras.

---

## Server

### 11. Reconciliación y estado duplicado

Con el ACK puesto en las acciones de grabación, la reconciliación solo sirve
ya para el broadcast. Renombrar la función a `reconcile_broadcast`: si
`len(browsers) > 0` y `broadcasting` es false, enviar `start_broadcast`; y al
revés, si




## otros 


12. la ruta de /status es publica y no tiene sentido. quita eso.


13. reaper de 12 h : creo que igual no hace ni falta. simplemente se queda la row incompleta asi y ya se sabe su significado
    



14. Secuencia:

Parsear y validar la cabecera.
INSERT de la fila (started_at, ended_at, duration_seconds, file_path, uploaded_at = NULL). Si falla → 503.
Subir el blob a Storage. Si falla → 503, y la fila se queda con uploaded_at NULL.
UPDATE uploaded_at = now(). Si falla → 503.



vale? o sea que : NO SE CREA LA FILA INSERT INTO AL INICIAR LA GRABACION. AHI NO SE HACE NADA DE ESO. ES AL FINAL . TAMPOCO ES CUANDO STOPRECORDING ES SUCCESFULL, SINO QUE CUANDO EL USUARIO SUBE EXITOSAMENTE LA FILA UPLOAD


Todo idempotente: el reintento de la ESP32 hace upsert de la fila y upsert del blob, así que repetir es gratis.