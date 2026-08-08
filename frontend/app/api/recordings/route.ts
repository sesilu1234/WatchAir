import { NextResponse } from "next/server";
import { auth } from "../../../auth";
import { deleteRecordings, listRecordings } from "../../lib/recordings.server";

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

// Borrado en bloque: `{ uuids: [...] }`. Una sola grabación es el caso de un
// elemento, así que no hace falta una ruta aparte para el borrado individual.
export async function DELETE(request: Request) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const uuids = (body as { uuids?: unknown })?.uuids;
  if (!Array.isArray(uuids) || uuids.length === 0 || !uuids.every((u) => typeof u === "string")) {
    return NextResponse.json({ error: "Falta la lista de uuids" }, { status: 400 });
  }

  try {
    await deleteRecordings(uuids);
  } catch (err) {
    return NextResponse.json({ error: `${err instanceof Error ? err.message : err}` }, { status: 502 });
  }
  return NextResponse.json({ deleted: uuids.length });
}
