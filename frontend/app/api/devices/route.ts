import { NextResponse } from "next/server";
import { auth } from "../../../auth";
import { listDevices } from "../../lib/devices.server";

// Alimenta el filtro por usuario en /recordings.
export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const devices = await listDevices();
  return NextResponse.json(devices);
}
