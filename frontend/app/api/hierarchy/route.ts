import { NextResponse } from 'next/server';

const CLOUD_API_URL = "http://13.206.34.214:8000/hierarchy";

export async function GET() {
  try {
    const response = await fetch(CLOUD_API_URL);
    if (!response.ok) {
      throw new Error(`Hierarchy Sync Failed: ${response.statusText}`);
    }
    const data = await response.json();
    return NextResponse.json(data);
  } catch (error: any) {
    console.error("The Map is obscured:", error);
    return NextResponse.json(
      { error: "A cloud has obscured the mind-map. Synchronization failed." },
      { status: 500 }
    );
  }
}
