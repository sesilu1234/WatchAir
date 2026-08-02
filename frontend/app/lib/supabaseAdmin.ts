import "server-only";
import { createClient } from "@supabase/supabase-js";

// Cliente con la service role key: bypassa RLS. Server-only — nunca se
// importa desde un componente "use client". Todo el contacto con Supabase
// (Postgres + Storage) vive en el frontend; server2 (EC2) no lo toca.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
);

export const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET ?? "watchair";
