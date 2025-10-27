import { NextResponse } from "next/server";
import { getProgressSnapshot } from "@/lib/server/progress";

export const runtime = "nodejs";

type RouteParams = {
  params: {
    id: string;
  };
};

export async function GET(_request: Request, { params }: RouteParams) {
  const id = params?.id?.trim();
  if (!id) {
    return NextResponse.json({ error: "Progress id is required" }, { status: 400 });
  }

  const snapshot = getProgressSnapshot(id);
  if (!snapshot) {
    return new NextResponse(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}
