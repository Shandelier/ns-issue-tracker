import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  AUTH_COOKIE_NAME,
  deriveCookieDigest,
  isAuthorizedCookie,
  readConfiguredPasswordHash,
  verifyPasswordAgainstHash,
} from "@/lib/auth";

export async function GET() {
  try {
    const expectedHash = readConfiguredPasswordHash();
    const cookieValue = cookies().get(AUTH_COOKIE_NAME)?.value;
    const authorized = isAuthorizedCookie(cookieValue, expectedHash);
    return NextResponse.json({ authorized });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Authentication is not configured" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const expectedHash = readConfiguredPasswordHash();
    const payload = (await request.json().catch(() => null)) as { password?: unknown } | null;
    const password = typeof payload?.password === "string" ? payload.password : "";

    if (!password) {
      return NextResponse.json({ error: "Password is required" }, { status: 400 });
    }

    if (!verifyPasswordAgainstHash(password, expectedHash)) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    const response = NextResponse.json({ authorized: true });
    response.cookies.set({
      name: AUTH_COOKIE_NAME,
      value: deriveCookieDigest(expectedHash),
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return response;
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "Authentication is not configured" }, { status: 500 });
  }
}

export async function DELETE() {
  const response = NextResponse.json({ authorized: false });
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
