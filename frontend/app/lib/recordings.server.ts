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

// --- Escrituras: solo las llaman las rutas /api/internal/*, nunca el navegador ---

export async function insertRecordingStarted(row: {
  uuid: string;
  device_uuid: string;
  started_at: string;
}): Promise<void> {
  // upsert+ignoreDuplicates en vez de insert: server2 puede reintentar esto (o
  // reconciliar el mismo uuid en cada reconexión del ESP32 vía hello) sin que
  // la fila ya existente reviente por choque de primary key.
  const { error } = await supabaseAdmin
    .from("recordings")
    .upsert(row, { onConflict: "uuid", ignoreDuplicates: true });
  if (error) throw new Error(`No se pudo crear la fila de grabación ${row.uuid}: ${error.message}`);
}

export async function completeRecording(params: {
  uuid: string;
  deviceUuid: string;
  data: Buffer;
}): Promise<void> {
  const { uuid, deviceUuid, data } = params;

  const { data: row, error: fetchError } = await supabaseAdmin
    .from("recordings")
    .select("started_at")
    .eq("uuid", uuid)
    .maybeSingle();
  if (fetchError) throw new Error(`No se pudo leer la grabación ${uuid}: ${fetchError.message}`);
  if (!row) throw new Error(`Grabación ${uuid} no existe (¿no se creó al arrancar?)`);

  const filePath = `${deviceUuid}/${uuid}.bin`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .upload(filePath, data, { contentType: "application/octet-stream", upsert: true });
  if (uploadError) throw new Error(`No se pudo subir ${filePath}: ${uploadError.message}`);

  const endedAt = new Date();
  const durationSeconds = Math.round((endedAt.getTime() - Date.parse(row.started_at)) / 1000);

  const { error: updateError } = await supabaseAdmin
    .from("recordings")
    .update({ ended_at: endedAt.toISOString(), file_path: filePath, duration_seconds: durationSeconds })
    .eq("uuid", uuid);
  if (updateError) throw new Error(`No se pudo cerrar la grabación ${uuid}: ${updateError.message}`);
}
