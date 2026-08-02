import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { getDeviceByEmail } from "./app/lib/devices.server";

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt" },
  pages: { signIn: "/login", error: "/login" },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
  ],
  callbacks: {
    // Aprovisionamiento hardcodeado: solo entran las cuentas con fila en
    // `devices`. Fuera de esas 3 personas, ni se crea sesión.
    async signIn({ user }) {
      if (!user.email) return false;
      const device = await getDeviceByEmail(user.email);
      return device !== null;
    },
    async jwt({ token, user }) {
      if (user?.email) {
        const device = await getDeviceByEmail(user.email);
        token.deviceUuid = device?.uuid ?? null;
        token.username = device?.username ?? null;
      }
      return token;
    },
    async session({ session, token }) {
      session.user.deviceUuid = token.deviceUuid as string | null;
      session.user.username = token.username as string | null;
      return session;
    },
  },
});
