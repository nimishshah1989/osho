const CLOUD_API_URL = "http://13.206.34.214:8000/ask";

export async function POST(req: Request) {
  try {
    const { query } = await req.json();

    if (!query) {
      return NextResponse.json({ error: "No query provided" }, { status: 400 });
    }

    // Switch to the remote EC2 Intelligence Engine
    const response = await fetch(CLOUD_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Cloud Analysis Failed: ${response.statusText}`);
    }

    const data = await response.json();
    return NextResponse.json({ wisdom: data.wisdom });

  } catch (error: any) {
    console.error("The Silence is deep:", error);
    return NextResponse.json(
      { error: "A cloud has obscured the moon. Synthesis failed." },
      { status: 500 }
    );
  }
}
