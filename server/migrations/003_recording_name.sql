-- WatchAir — columna `name`. Pegar en el SQL Editor de Supabase sobre la base
-- que ya crearon 001_init.sql y 002_uploaded_at.sql.
--
-- Por qué: hasta ahora el nombre visible se derivaba siempre del inicio de la
-- grabación ("REC_20260728_100200", ver frontend/app/lib/format.ts). Esta
-- columna guarda el nombre que le ponga el usuario desde la UI; NULL = no le ha
-- puesto ninguno y se sigue derivando del inicio, que es el caso por defecto.
--
-- La ESP32 y server2 no la tocan: la subida sigue haciendo upsert de las mismas
-- columnas de siempre, así que un reintento no puede pisar el nombre elegido.

alter table recordings add column if not exists name text;
