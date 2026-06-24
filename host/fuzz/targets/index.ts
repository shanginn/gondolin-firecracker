import type { FuzzTarget } from "./types.ts";
import { virtioTarget } from "./virtio.ts";
import { tarTarget } from "./tar.ts";
import { sshExecTarget } from "./ssh-exec.ts";

export const targets: Record<string, FuzzTarget> = {
  [virtioTarget.name]: virtioTarget,
  [tarTarget.name]: tarTarget,
  [sshExecTarget.name]: sshExecTarget,
};
