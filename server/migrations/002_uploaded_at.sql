-- WatchAir — columna `uploaded_at`. Pegar en el SQL Editor de Supabase sobre la
-- base que ya creó 001_init.sql (en una base nueva no hace falta: 001 ya la trae).
--
-- Por qué: la fila ya no se crea al empezar a grabar, sino cuando la ESP32 sube
-- el fichero, en tres pasos — INSERT de la fila, blob a Storage, UPDATE de
-- uploaded_at. Si el segundo paso falla, la fila se queda con uploaded_at NULL
-- y eso es exactamente lo que la distingue de una grabación completa: existe,
-- pero le falta el binario. La ESP32 reintenta la subida entera hasta el 200.

alter table recordings add column if not exists uploaded_at timestamptz;

-- Las grabaciones que ya estaban cerradas antes de este cambio tienen su
-- fichero en Storage: se dan por subidas para que la UI no las marque como
-- pendientes para siempre.
update recordings set uploaded_at = coalesce(ended_at, created_at)
where uploaded_at is null and file_path is not null;

-- Tabla resultante:
--
--   recordings (
--     uuid              uuid primary key,
--     device_uuid       uuid not null references devices(uuid),
--     started_at        timestamptz not null,   -- de la cabecera del .bin
--     ended_at          timestamptz,            -- started_at + t de la última muestra
--     file_path         text,                   -- ruta dentro del bucket "watchair"
--     duration_seconds  integer,
--     uploaded_at       timestamptz,            -- null = binario no confirmado en Storage
--     created_at        timestamptz not null default now()
--   )
