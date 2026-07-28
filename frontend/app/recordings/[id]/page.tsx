import { notFound } from "next/navigation";
import { getRecording, type Recording } from "../../lib/api";
import LiveRecordingView from "./LiveRecordingView";
import RecordingPlayback from "./RecordingPlayback";
import { Notice } from "./ui";

// Server Component: decide qué vista toca antes de mandar nada al navegador.
// `no-store` (dentro de getRecording) es clave: si esto se cacheara, una
// grabación recién terminada seguiría pintándose como si estuviera en curso.
export default async function RecordingPage(props: PageProps<"/recordings/[id]">) {
  const { id } = await props.params;

  let recording: Recording | null;
  try {
    recording = await getRecording(id);
  } catch {
    return (
      <Notice
        title="No se puede contactar con el servidor"
        detail="El backend no responde. Compruébalo y vuelve a intentarlo."
        action={{ href: "/recordings", label: "Volver a Grabaciones" }}
      />
    );
  }

  if (recording === null) notFound();

  // ended_at === null <=> la grabación sigue abierta en el server.
  // key: al navegar entre grabaciones se remonta la vista con el estado limpio.
  return recording.ended_at === null ? (
    <LiveRecordingView key={recording.id} recording={recording} />
  ) : (
    <RecordingPlayback key={recording.id} recording={recording} />
  );
}
