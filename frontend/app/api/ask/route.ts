import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import path from 'path';

export async function POST(req: NextRequest) {
  try {
    const { query } = await req.json();

    if (!query) {
      return NextResponse.json({ error: 'No query provided' }, { status: 400 });
    }

    // Sanitize query to prevent shell injection
    const sanitizedQuery = query.replace(/["$`\\]/g, '');

    const projectRoot = path.resolve(process.cwd(), '..');
    const venvPython = path.join(projectRoot, '.venv', 'bin', 'python3');
    const cachePath = path.join(projectRoot, 'data', 'cache');
    
    // Scripts
    const ollamaScript = path.join(projectRoot, 'scripts', 'rag.py');
    const geminiScript = path.join(projectRoot, 'scripts', 'gemini_rag.py');

    const tryOllama = () => {
      const command = `export HF_HOME="${cachePath}" && export TRANSFORMERS_CACHE="${cachePath}" && ${venvPython} ${ollamaScript} "${sanitizedQuery}"`;
      return new Promise((resolve, reject) => {
        exec(command, { cwd: projectRoot }, (error, stdout, stderr) => {
          if (error || stdout.includes("Error:") || stdout.includes("Connection refused")) {
            return reject(error || stdout);
          }
          resolve(stdout);
        });
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
