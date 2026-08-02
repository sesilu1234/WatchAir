import { NextResponse } from "next/server";
import { auth } from "./auth";

// `middleware.ts` se llama `proxy.ts` desde Next 16. Protege todas las rutas
// salvo login/auth/estáticos: sin sesión, redirige a /login.
export default auth((req) => {
  if (!req.auth) {
    return NextResponse.redirect(new URL("/login", req.url));
  }
});

// Todas las rutas /api/* quedan fuera: cada una hace su propia comprobación
// (sesión para las de usuario, Bearer INTERNAL_API_SECRET para /api/internal/*
// que llama server2 sin cookies de navegador) y devuelve 401 en JSON en vez
// de un redirect a /login, que rompería una llamada máquina-a-máquina.
export const config = {
  matcher: ["/((?!api|login|_next/static|_next/image|favicon.ico).*)"],
};
