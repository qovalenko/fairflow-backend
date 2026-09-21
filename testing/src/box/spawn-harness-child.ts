import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

export interface BoxChildReady {
  grpcPort?: number;
  httpPort: number;
}

/** Spawn a box harness child and wait for the JSON ready line on stdout. */
export async function spawnBoxHarnessChild(
  scriptName: "box-control-child.mjs" | "box-gateway-child.mjs",
  env: NodeJS.ProcessEnv,
): Promise<{ child: ChildProcess; ready: BoxChildReady }> {
  const scriptPath = join(__dirname, "..", "..", "scripts", scriptName);
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const ready = await new Promise<BoxChildReady>((resolve, reject) => {
    let buffer = "";
    let errBuffer = "";
    child.stderr.on("data", (chunk) => {
      errBuffer += chunk.toString();
    });
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("{")) continue;
        try {
          const parsed = JSON.parse(line) as BoxChildReady & { ready?: boolean };
          if (parsed.ready) {
            child.stdout.off("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          /* wait for full JSON line */
        }
      }
    };
    child.stdout.on("data", onData);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(
          new Error(
            `${scriptName} exited with code ${code}${errBuffer ? `: ${errBuffer.trim()}` : ""}`,
          ),
        );
      }
    });
  });

  return { child, ready };
}

export async function stopBoxHarnessChild(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 15_000);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
