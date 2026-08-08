import { NextResponse } from "next/server";
import { auth } from "../../../../auth";
import { renameRecording } from "../../../lib/recordings.server";

const MAX_NAME_LENGTH = 80;

// Renombrar: `{ name: string | null }`. En blanco o null quita el nombre propio
// y la grabación vuelve a llamarse como su instante de inicio.
export async function PATCH(request: Request, { params }: { params: Promise<{ uuid: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  const name = (body as { name?: unknown })?.name;
  if (name !== null && typeof name !== "string") {
    return NextResponse.json({ error: "`name` tiene que ser texto o null" }, { status: 400 });
  }
  if (typeof name === "string" && name.trim().length > MAX_NAME_LENGTH) {
    return NextResponse.json(
      { error: `El nombre no puede pasar de ${MAX_NAME_LENGTH} caracteres` },
      { status: 400 },
    );
  }

  const { uuid } = await params;
  try {
    await renameRecording(uuid, name);
  } catch (err) {
    return NextResponse.json({ error: `${err instanceof Error ? err.message : err}` }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
