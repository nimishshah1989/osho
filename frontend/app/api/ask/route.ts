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
      });
    };

    const tryGemini = () => {
      const command = `export HF_HOME="${cachePath}" && export TRANSFORMERS_CACHE="${cachePath}" && ${venvPython} ${geminiScript} "${sanitizedQuery}"`;
      return new Promise((resolve, reject) => {
        exec(command, { cwd: projectRoot }, (error, stdout, stderr) => {
          if (error) return reject(error);
          resolve(stdout);
        });
      });
    };

    try {
      // 1. Try local Ollama first
      const output = await tryOllama().catch(async () => {
        console.log("Ollama unavailable, falling back to Gemini...");
        return await tryGemini();
      }) as string;

      // Parse the section after the equals signs
      const outputParts = output.split("=").filter(p => p.trim());
      const wisdom = outputParts.length > 2 ? outputParts[outputParts.length - 1].trim() : output;

      return NextResponse.json({ wisdom });
    } catch (error) {
      console.error('All synthesis engines failed:', error);
      return NextResponse.json({ error: 'The Engine is currently silent. Please check your API configurations.' }, { status: 500 });
    }

  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
