import "server-only";
import { STORAGE_BUCKET, supabaseAdmin } from "./supabaseAdmin";

// `ended_at` es null hasta que el binario está subido y confirmado en
// Storage — no hay un `status` aparte, esa es la única señal persistida.
// "grabando" vs "subiendo" es un estado transitorio que solo vive en el WS
// de server2 (ver recording_started/recording_stopping/recording_finished).
export type Recording = {
  uuid: string;
  device_uuid: string;
  started_at: string;
  ended_at: string | null;
  file_path: string | null;
  duration_seconds: number | null;
  username: string;
};

const SELECT_WITH_USERNAME = "uuid, device_uuid, started_at, ended_at, file_path, duration_seconds, devices(username)";

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
