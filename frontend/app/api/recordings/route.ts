import { NextResponse } from "next/server";
import { auth } from "../../../auth";
import { listRecordings } from "../../lib/recordings.server";

// Multi-usuario: todas las grabaciones de todas las cuentas son públicas
// entre ellas por ahora (ver toDo.md). Filtros opcionales por dispositivo y
// rango de fechas.
export async function GET(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const recordings = await listRecordings({
    deviceUuid: searchParams.get("device_uuid") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
  });
  return NextResponse.json(recordings);
}
