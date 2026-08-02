import "server-only";

// Autentica las llamadas server2 -> frontend en /api/internal/*. No es la
// sesión de ningún usuario: un secreto fijo servidor-a-servidor (ver
// server/app/internal_client.py, que es el único que llama a estas rutas).
export function isValidInternalRequest(request: Request): boolean {
  const auth = request.headers.get("authorization");
  return auth === `Bearer ${process.env.INTERNAL_API_SECRET}`;
}
