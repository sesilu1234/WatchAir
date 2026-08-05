-- WatchAir v2 — esquema inicial. Pegar entero en el SQL Editor de Supabase
-- (Project pgizvbymylpxeufikiyb) y ejecutar una sola vez.

create table devices (
  uuid       uuid primary key,
  username   text not null,
  email      text not null unique,
  created_at timestamptz not null default now()
);

-- La fila nace cuando la ESP32 sube el fichero, no al empezar a grabar: hasta
-- entonces la grabación solo existe en su SD. started_at/ended_at salen de la
-- cabecera del .bin, nunca de la hora del server.
create table recordings (
  uuid              uuid primary key,
  device_uuid       uuid not null references devices(uuid),
  started_at        timestamptz not null,
  ended_at          timestamptz,
  file_path         text,          -- ruta dentro del bucket "watchair"
  duration_seconds  integer,
  uploaded_at       timestamptz,   -- null = la fila existe pero el binario no llegó a Storage
  created_at        timestamptz not null default now()
);

create index recordings_device_uuid_idx on recordings (device_uuid);
create index recordings_started_at_idx on recordings (started_at desc);

-- Aprovisionamiento hardcodeado de los 3 usuarios de la familia. Hoy solo
-- existe físicamente el ESP32 de Ulises; los otros dos UUID quedan listos
-- para cuando se monte su hardware (van hardcodeados en su firmware).
insert into devices (uuid, username, email) values
  ('8d257ddd-79bc-4fc7-969c-8ba42d315b22', 'Ulises',  'ulisesplarocher@gmail.com'),
  ('01bbe27b-7b83-4247-839e-0826b23f473c', 'Angela',  'rochermunozangela@gmail.com'),
  ('af87778a-9e0c-4445-ad5e-62d78943272e', 'Minerva', 'minervaplarocher@gmail.com');

-- Para añadir a alguien más en el futuro: generar un UUID nuevo y un secreto
-- propio, hardcodearlos en el firmware de su ESP32 (esp32/include/secrets.h),
-- añadir el par a DEVICE_SECRETS de server/.env y:
-- insert into devices (uuid, username, email) values ('<uuid>', '<nombre>', '<email>');
