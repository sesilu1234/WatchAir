import { NextResponse } from "next/server";
import { isValidInternalRequest } from "../../../lib/internalAuth.server";
import { insertRecordingStarted } from "../../../lib/recordings.server";

// Llamada por server2 justo después del ACK del ESP32 (ver
// server/app/internal_client.py:notify_recording_started). La fila solo
// nace aquí: si esto no responde 200, server2 reintenta solo.
export async function POST(request: Request) {
  if (!isValidInternalRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const { uuid, device_uuid, started_at } = body ?? {};
  if (typeof uuid !== "string" || typeof device_uuid !== "string" || typeof started_at !== "string") {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  await insertRecordingStarted({ uuid, device_uuid, started_at });
  return NextResponse.json({ ok: true });
}
