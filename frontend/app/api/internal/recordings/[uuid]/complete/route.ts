import { NextResponse } from "next/server";
import { isValidInternalRequest } from "../../../../../lib/internalAuth.server";
import { completeRecording } from "../../../../../lib/recordings.server";

// Llamada por server2 una vez el binario ya está completo y verificado
// (tamaño+checksum) en su disco local (ver server/app/internal_client.py:
// notify_recording_complete). Sube a Supabase Storage y cierra la fila
// (ended_at, file_path, duration_seconds) — es la única escritura que marca
// una grabación como terminada.
export async function POST(request: Request, { params }: { params: Promise<{ uuid: string }> }) {
  if (!isValidInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { uuid } = await params;
  const deviceUuid = request.headers.get("x-device-uuid");
  if (!deviceUuid) {
    return NextResponse.json({ error: "falta X-Device-Uuid" }, { status: 400 });
  }

  const data = Buffer.from(await request.arrayBuffer());
  if (data.length === 0) {
    return NextResponse.json({ error: "cuerpo vacío" }, { status: 400 });
  }

  await completeRecording({ uuid, deviceUuid, data });
  return NextResponse.json({ ok: true });
}
