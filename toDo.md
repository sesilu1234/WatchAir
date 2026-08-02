# WatchAir — arquitectura

repo: WatchAir, carpetas esp32/, server/ (fastapi), frontend/ (next.js).
usuarios: 2-3 personas (familia), cada cuenta google tiene asociado un device (ESP32 + sensor SDP810 + cánula).

## frontend (next.js en vercel = server1)

rutas: /realtime (live), /recordings (lista + botón grabar), /recording/[id] (detalle: gráfica ECharts con pan/zoom si terminada; vista tipo live si en curso, check server-side por ended_at).

apartado nuevo: ver las grabaciones de todos los usuarios, no solo las tuyas. aparecen todas, con filtro por usuario y por fecha. por ahora todo es público entre cuentas; más adelante flag público/privado por grabación (privado por defecto).

regla de gaps en las gráficas: si el salto entre muestras consecutivas supera 2×LOOP_TIME, no se unen esos puntos; el hueco se pinta dentro de la misma grabación.

## auth

- login con NextAuth/Auth.js + Google en server1.
- server1 emite un JWT de ~15 min firmado (HS256) con JWT_SHARED_SECRET. en el claim van el email y el uuid_device del usuario. NO se manda el uuid aparte: firma válida = uuid de fiar.
- el mismo token vale para todo contra server2: WS por /ws?token=... y HTTP con header Authorization: Bearer <token>.
- caducidad: server2 responde 401 (HTTP) o cierra el socket (WS) → el frontend pide token nuevo a server1 y reintenta en silencio. el token nunca es fijo.
- server1 no puentea comandos: solo auth + frontend. un único camino de auth.

## backend

- server2: fastapi en la EC2, expuesto por cloudflared (named tunnel → wss:// y https:// estables, sin mixed content).
- la ESP32 se autentica ante server2 con DEVICE_SECRET (hardcodeado en firmware por ahora) + su DEVICE_UUID.
- aprovisionamiento hardcodeado: fila en BD con uuid_device, username, email.
- BD: supabase (postgres) para usuarios/devices y metadatos de grabaciones. los ficheros los recibe server2 en disco; opcionalmente los empuja luego a supabase storage y la fila guarda la ruta.

tablas (orientativo, que claude code haga las migraciones):

- devices: uuid (pk), username, email
- recordings: uuid (pk), device_uuid (fk), started_at, ended_at (null = en curso), status (grabando | esperando_fichero | subiendo | completa | sin_fichero), file_path, duration

env vars:

- vercel: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, AUTH_SECRET, JWT_SHARED_SECRET, NEXT_PUBLIC_SERVER2_URL
- server2: JWT_SHARED_SECRET, DEVICE_SECRET, DATABASE_URL
- firmware: WIFI_SSID, WIFI_PASS, DEVICE_UUID, DEVICE_SECRET, SERVER2_URL

## conexión ESP32 ↔ server2

- la ESP32 es cliente WS de server2. al conectar manda un frame hello: {hello, uuid, rec_en_curso, t_ms, pending[]} → server2 reconstruye su estado desde ahí. si server2 y ESP32 discrepan, gana la ESP32 (es la fuente de verdad).
- heartbeat de aplicación cada 2 s desde la ESP32 con su estado real: {broadcasting, recording}. server2 actualiza last_seen[uuid].
- vida: last_seen < 3 s → online. server2 empuja device_online / device_offline por WS a los browsers suscritos. la UI NO hace polling http de estado, solo escucha su WS (y si se le cae, reconecta con backoff 1-2-5 s).
- reconciliación de comandos: server2 compara estado deseado vs reportado en el heartbeat. si quiere broadcast y el heartbeat dice broadcasting=false unos segundos → reenvía start_broadcast. igual para stop. un comando perdido se autocorrige solo.

## live view

- el browser abre /ws?token=..., server2 saca el device del claim y lo suscribe a ese aparato. varios browsers de la misma cuenta pueden mirar a la vez.
- emisión como estado derivado: ≥1 suscriptor → server2 manda start_broadcast a la ESP32; 0 suscriptores → stop_broadcast. el browser no manda comandos de emisión nunca.
- la ESP32 (con el sensor siempre activo) envía las measures una a una a 25 Hz; server2 las redirige a los suscriptores. sin batching.
- si hay grabación en curso, pulsar live view lleva a /realtime y se ve el directo normal. flags grabando/emitiendo independientes en firmware.

## grabación

- botón en /recordings → POST (Bearer) a server2 → server2 genera el uuid de grabación y se lo pide a la ESP32 por su WS.
- la fila en BD solo nace con el ACK de la ESP32. sin ACK en ~5 s → fail al browser, la huérfana se descarta (al re-pulsar, la ESP32 descarta la suya y arranca de cero).
- si ya hay grabación en curso con fila válida: botón deshabilitado en UI (se ve estado "grabando"); si alguien fuerza la request, server2 responde "grabación en curso, pare antes la actual". NUNCA se borra una grabación válida por un start nuevo.
- iniciar grabación siempre enciende el sensor, esté como esté.
- la ESP32 graba en su microSD y es la fuente de verdad. graba aunque no haya wifi; para PARAR sí hace falta conexión.
- formato: fichero binario /rec/<uuid>.bin con cabecera (magic, versión, uuid, Hz) + registros fijos de 6 bytes (uint32 t_ms + int16 p_centiPa) a 25 Hz, escritura por bloques de ~512 B.
- tope 12 h contado por la ESP32 en muestras (12 h × 25 Hz = 1.080.000 registros), sin reloj.
- reinicio en mitad de grabación: marcador de sesión en la SD → al arrancar detecta la grabación y SIGUE apendeando al mismo fichero. el segmento post-reinicio lleva timestamps relativos a millis().
- hora real: NTP (configTime) al conectar wifi. como subir requiere wifi, en ese momento se recalculan hacia atrás los tiempos del segmento post-reinicio (t_real = ahora_ntp − (millis_ahora − millis_muestra)) y el gap queda medido exacto; se pinta con la regla de gaps.
- stop: el browser manda stop_recording → server2 responde enseguida "parada, subiendo" (el browser no espera la subida; ve el estado de la fila cambiar).
- subida: ESP32 → server2, reanudable por offset. no se sube mientras se graba. borrar de la SD solo tras confirmación de server2 (tamaño + checksum). estados de fila: grabando → esperando_fichero → subiendo → completa (o sin_fichero si algo muere definitivamente).
