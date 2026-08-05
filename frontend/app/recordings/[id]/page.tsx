import { notFound } from "next/navigation";
import { getRecording, type Recording } from "../../lib/recordings.server";
import RecordingPlayback from "./RecordingPlayback";
import { Notice } from "./ui";

// Server Component: decide qué vista toca antes de mandar nada al navegador,
// leyendo Supabase directo (nunca desde el navegador). Sin caché: si esto se
// cacheara, una grabación recién subida seguiría pintándose como pendiente.
//
// Aquí solo se reproducen grabaciones terminadas: la que está en curso no tiene
// fila todavía (nace al subir el fichero) y se ve desde /recordings y /realtime.
export default async function RecordingPage(props: PageProps<"/recordings/[id]">) {
  const { id } = await props.params;

  let recording: Recording | null;
  try {
    recording = await getRecording(id);
  } catch {
    return (
      <Notice
        title="No se puede leer la grabación"
        detail="Hubo un problema hablando con Supabase. Vuelve a intentarlo."
        action={{ href: "/recordings", label: "Volver a Grabaciones" }}
      />
    );
  }

  if (recording === null) notFound();

  // Fila sin uploaded_at: se creó, pero el binario no llegó a Storage. La ESP32
  // conserva su copia y reintenta la subida sola, así que no se ha perdido nada.
  if (recording.uploaded_at === null) {
    return (
      <Notice
        title="Grabación pendiente de subir"
        detail="El fichero sigue en la ESP32 y se está reintentando la subida. En cuanto termine, esta página mostrará la señal."
        action={{ href: "/recordings", label: "Volver a Grabaciones" }}
      />
    );
  }

  // key: al navegar entre grabaciones se remonta la vista con el estado limpio.
  return <RecordingPlayback key={recording.uuid} recording={recording} />;
}
