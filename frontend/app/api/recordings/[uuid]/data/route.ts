import { NextResponse } from "next/server";
import { auth } from "../../../../../auth";
import { decodeRecording } from "../../../../lib/binaryFormat";
import { downloadRecordingFile, getRecording } from "../../../../lib/recordings.server";

// Puntos [segundos, presión] listos para ECharts, con la regla de gaps ya
// aplicada (ver binaryFormat.ts). Sustituye al CSV que servía server2 antes.
export async function GET(request: Request, { params }: { params: Promise<{ uuid: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { uuid } = await params;
  const recording = await getRecording(uuid);
  if (!recording) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (!recording.file_path) {
    return NextResponse.json({ error: "La grabación todavía no tiene fichero" }, { status: 409 });
  }

  const buffer = await downloadRecordingFile(recording.file_path);
  const points = decodeRecording(buffer);

  const { searchParams } = new URL(request.url);
  if (searchParams.get("format") !== "csv") return NextResponse.json(points);

  const csv = ["t_s,p", ...points.map(([t, p]) => `${t},${p ?? ""}`)].join("\n");
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${uuid}.csv"`,
    },
  });
}
