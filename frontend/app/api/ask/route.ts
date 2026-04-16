const CLOUD_API_URL = "http://13.206.34.214:8000/stream";

import { NextResponse } from 'next/server';

export async function POST(req: Request) {
  try {
    const { query } = await req.json();

    if (!query) {
      return NextResponse.json({ error: "No query provided" }, { status: 400 });
    }

    // Switch to the remote EC2 Streaming Engine
    const response = await fetch(CLOUD_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Cloud Analysis Failed: ${response.statusText}`);
    }

    // Proxy the readable stream directly to the frontend
    return new Response(response.body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });

  } catch (error: any) {
    console.error("The Silence is deep:", error);
    return NextResponse.json(
      { error: "A cloud has obscured the moon. Synthesis failed." },
      { status: 500 }
    );
  }
}
