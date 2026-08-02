import { notFound } from "next/navigation";
import { getRecording, type Recording } from "../../lib/recordings.server";
import LiveRecordingView from "./LiveRecordingView";
import RecordingPlayback from "./RecordingPlayback";
import { Notice } from "./ui";

// Server Component: decide qué vista toca antes de mandar nada al navegador,
// leyendo Supabase directo (nunca desde el navegador). Sin caché: si esto se
// cacheara, una grabación recién terminada seguiría pintándose como en curso.
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

  // ended_at === null <=> sigue grabando o subiendo (LiveRecordingView cubre
  // las dos fases). key: al navegar entre grabaciones se remonta la vista
  // con el estado limpio.
  return recording.ended_at === null ? (
    <LiveRecordingView key={recording.uuid} recording={recording} />
  ) : (
    <RecordingPlayback key={recording.uuid} recording={recording} />
  );
}
