import "server-only";
import { STORAGE_BUCKET, supabaseAdmin } from "./supabaseAdmin";

// Aquí solo hay grabaciones terminadas: la fila la crea server2 cuando la ESP32
// le sube el fichero, así que la que se está grabando ahora mismo no aparece
// (eso vive en el `status` del aparato, que llega por el WS de server2).
//
// `uploaded_at` null = la fila se creó pero el binario no llegó a Storage; la
// ESP32 lo reintenta sola. Es la única señal persistida de "completa o no".
export type Recording = {
  uuid: string;
  device_uuid: string;
  started_at: string;
  ended_at: string | null;
  file_path: string | null;
  duration_seconds: number | null;
  uploaded_at: string | null;
  username: string;
};

const SELECT_WITH_USERNAME =
  "uuid, device_uuid, started_at, ended_at, file_path, duration_seconds, uploaded_at, devices(username)";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withUsername(row: any): Recording {
  const { devices, ...rest } = row;
  return { ...rest, username: devices?.username ?? "?" };
}

export async function listRecordings(filters: {
  deviceUuid?: string;
  from?: string;
  to?: string;
} = {}): Promise<Recording[]> {
  let query = supabaseAdmin
    .from("recordings")
    .select(SELECT_WITH_USERNAME)
    .order("started_at", { ascending: false });

  if (filters.deviceUuid) query = query.eq("device_uuid", filters.deviceUuid);
  if (filters.from) query = query.gte("started_at", filters.from);
  if (filters.to) query = query.lte("started_at", filters.to);

  const { data, error } = await query;
  if (error) throw new Error(`No se pudieron listar las grabaciones: ${error.message}`);
  return (data ?? []).map(withUsername);
}

export async function getRecording(uuid: string): Promise<Recording | null> {
  const { data, error } = await supabaseAdmin
    .from("recordings")
    .select(SELECT_WITH_USERNAME)
    .eq("uuid", uuid)
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer la grabación ${uuid}: ${error.message}`);
  return data ? withUsername(data) : null;
}

export async function downloadRecordingFile(filePath: string): Promise<Buffer> {
  const { data, error } = await supabaseAdmin.storage.from(STORAGE_BUCKET).download(filePath);
  if (error) throw new Error(`No se pudo descargar ${filePath}: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

// Las escrituras (crear la fila, subir el .bin a Storage, cerrar la grabación)
// las hace server2 directamente contra Supabase — ver server/app/db.py. Aquí
// solo quedan lecturas.
