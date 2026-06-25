import type { SshExecRequest } from "../net/ssh.ts";

export type GitSshExecInfo = {
  /** git service name, for example `git-upload-pack` */
  service: string;
  /** git repo path, for example `org/name.git` */
  repo: string;
};

function splitSshExecCommand(command: string): string[] | null {
  const out: string[] = [];
  let i = 0;

  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i]!)) i += 1;
    if (i >= command.length) break;

    let cur = "";
    let mode: "none" | "single" | "double" = "none";

    while (i < command.length) {
      const ch = command[i]!;

      if (mode === "none") {
        if (/\s/.test(ch)) break;
        if (ch === "'") {
          mode = "single";
          i += 1;
          continue;
        }
        if (ch === '"') {
          mode = "double";
          i += 1;
          continue;
        }
        if (ch === "\\") {
          i += 1;
          if (i >= command.length) return null;
          cur += command[i]!;
          i += 1;
          continue;
        }
        cur += ch;
        i += 1;
        continue;
      }

      if (mode === "single") {
        if (ch === "'") {
          mode = "none";
          i += 1;
          continue;
        }
        cur += ch;
        i += 1;
        continue;
      }

      if (ch === '"') {
        mode = "none";
        i += 1;
        continue;
      }
      if (ch === "\\") {
        i += 1;
        if (i >= command.length) return null;
        cur += command[i]!;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
    }

    if (mode !== "none") return null;
    out.push(cur);
    while (i < command.length && /\s/.test(command[i]!)) i += 1;
  }

  return out;
}

function basenamePosix(value: string): string {
  const idx = value.lastIndexOf("/");
  return idx === -1 ? value : value.slice(idx + 1);
}

/**
 * Best-effort parser for canonical git-over-SSH exec commands
 */
export function getInfoFromSshExecRequest(
  req: SshExecRequest,
): GitSshExecInfo | null {
  const argv = splitSshExecCommand(req.command);
  if (!argv || argv.length !== 2) return null;

  const serviceArg = argv[0]!.trim();
  if (!/^(?:\/)?(?:[a-z0-9._+-]+\/)*git-[a-z0-9][a-z0-9-]*$/i.test(serviceArg))
    return null;

  const service = basenamePosix(serviceArg);
  if (!/^git-[a-z0-9][a-z0-9-]*$/i.test(service)) return null;

  let repo = argv[1]!.trim();
  if (!repo) return null;

  if (repo.startsWith("~/")) repo = repo.slice(2);
  repo = repo.replace(/^\/+/, "").replace(/\/+$/, "");

  if (!repo.includes("/")) return null;
  if (repo.includes("..")) return null;
  if (repo.startsWith("-")) return null;
  if (
    !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+(?:\.git)?$/i.test(repo)
  ) {
    return null;
  }

  return { service, repo };
}
