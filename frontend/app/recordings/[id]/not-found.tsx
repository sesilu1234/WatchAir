import { Notice } from "./ui";

export default function RecordingNotFound() {
  return (
    <Notice
      title="No se encontró esta grabación"
      detail="El identificador no corresponde a ninguna grabación del servidor."
      action={{ href: "/recordings", label: "Volver a Grabaciones" }}
    />
  );
}
