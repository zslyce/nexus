/**
 * Finds the process that listens on a local TCP port. Used to identify the service Nexus talked to, even when
 * its registration file is not the one that was expected. Read-only: it never signals anything.
 */
import { execFile } from "node:child_process";

/** Parses `netstat -ano -p TCP` output (Windows): the pid of the LISTENING socket on `port`. */
export function parseNetstatListeningPid(output: string, port: number): number | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (match && Number(match[1]) === port) return Number(match[2]);
  }
  return undefined;
}

/** Parses `lsof -t` output (one pid per line): the first pid, if any. */
export function parseLsofPid(output: string): number | undefined {
  const first = output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^\d+$/.test(line));
  return first === undefined ? undefined : Number(first);
}

/** Pid listening on `port` at 127.0.0.1, or `undefined` when nothing (or nothing readable) listens there. */
export function listeningPid(port: number, platform: NodeJS.Platform = process.platform): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (platform === "win32") {
      execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true }, (error, stdout) => {
        resolve(error ? undefined : parseNetstatListeningPid(stdout, port));
      });
      return;
    }
    execFile("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], (error, stdout) => {
      resolve(error ? undefined : parseLsofPid(stdout));
    });
  });
}
