import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      name?: string | null;
      email?: string | null;
      image?: string | null;
      deviceUuid: string | null;
      username: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    deviceUuid?: string | null;
    username?: string | null;
  }
}
