import { SignJWT } from "jose";
import { NextResponse } from "next/server";
import { auth } from "../../../auth";

const TTL_SECONDS = 15 * 60;
const secret = new TextEncoder().encode(process.env.JWT_SHARED_SECRET);

// El único puente entre server1 y server2: firma un JWT corto (HS256) con
// los claims que server2 necesita (email + uuid_device). server1 nunca
// reenvía comandos, solo emite este token — el navegador habla con server2
// directamente (WS /ws?token=... y HTTP Authorization: Bearer <token>).
export async function GET() {
  const session = await auth();
  if (!session?.user?.deviceUuid) {
    return NextResponse.json({ error: "No autenticado o sin dispositivo asociado" }, { status: 401 });
  }

  const token = await new SignJWT({ email: session.user.email, uuid_device: session.user.deviceUuid })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(secret);

  return NextResponse.json({ token, expiresIn: TTL_SECONDS });
}
