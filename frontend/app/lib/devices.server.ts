import "server-only";
import { supabaseAdmin } from "./supabaseAdmin";

export type Device = { uuid: string; username: string; email: string };

export async function getDeviceByEmail(email: string): Promise<Device | null> {
  const { data, error } = await supabaseAdmin
    .from("devices")
    .select("uuid, username, email")
    .eq("email", email)
    .maybeSingle();
  if (error) throw new Error(`No se pudo resolver el device de ${email}: ${error.message}`);
  return data;
}

// Sin email: es lo que alimenta el filtro por usuario en /recordings, no hace
// falta exponer más que uuid+username.
export async function listDevices(): Promise<Pick<Device, "uuid" | "username">[]> {
  const { data, error } = await supabaseAdmin
    .from("devices")
    .select("uuid, username")
    .order("username");
  if (error) throw new Error(`No se pudo listar devices: ${error.message}`);
  return data;
}
