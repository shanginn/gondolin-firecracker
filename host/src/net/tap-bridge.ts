import { EventEmitter } from "events";
import child_process from "child_process";
import type { ChildProcessWithoutNullStreams } from "child_process";

const PYTHON = String.raw`
import os, selectors, signal, socket, struct, subprocess, sys

ETH_P_ALL = 0x0003
PACKET_OUTGOING = 4

name = sys.argv[1]
tap_created = False

def run(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

def cleanup():
    global tap_created
    if tap_created:
        subprocess.run(["ip", "link", "del", "dev", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tap_created = False

def die(msg):
    print("ERROR " + msg, file=sys.stderr, flush=True)
    cleanup()
    sys.exit(1)

def on_signal(signum, frame):
    cleanup()
    sys.exit(0)

signal.signal(signal.SIGTERM, on_signal)
signal.signal(signal.SIGINT, on_signal)

try:
    cleanup()
    run("ip", "tuntap", "add", "dev", name, "mode", "tap")
    tap_created = True
    run("ip", "link", "set", "dev", name, "up")
    sock = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.htons(ETH_P_ALL))
    sock.bind((name, 0))
    sock.setblocking(False)
    os.set_blocking(0, False)
except Exception as e:
    die(str(e))

sel = selectors.DefaultSelector()
sel.register(sock, selectors.EVENT_READ, "tap")
sel.register(0, selectors.EVENT_READ, "stdin")
stdin_buf = b""

print("READY", file=sys.stderr, flush=True)

try:
    while True:
        for key, mask in sel.select():
            if key.data == "tap":
                try:
                    frame, addr = sock.recvfrom(65536)
                except BlockingIOError:
                    continue
                if len(addr) >= 3 and addr[2] == PACKET_OUTGOING:
                    continue
                os.write(1, struct.pack("!I", len(frame)) + frame)
            else:
                try:
                    chunk = os.read(0, 65536)
                except BlockingIOError:
                    continue
                if not chunk:
                    cleanup()
                    sys.exit(0)
                stdin_buf += chunk
                while len(stdin_buf) >= 4:
                    n = struct.unpack("!I", stdin_buf[:4])[0]
                    if len(stdin_buf) < 4 + n:
                        break
                    frame = stdin_buf[4:4+n]
                    stdin_buf = stdin_buf[4+n:]
                    sock.send(frame)
finally:
    cleanup()
`;

export class TapPacketBridge extends EventEmitter {
  readonly name: string;
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = Buffer.alloc(0);
  private paused = false;
  private waitingDrain = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  constructor(name: string) {
    super();
    this.name = name;
  }

  async start(): Promise<void> {
    if (this.child) return this.readyPromise ?? Promise.resolve();

    this.stdoutBuffer = Buffer.alloc(0);
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    const child = child_process.spawn(
      "python3",
      ["-u", "-c", PYTHON, this.name],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;

    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.handleStderr(chunk));
    child.on("error", (err) => {
      this.readyReject?.(err);
      this.emit("error", err);
    });
    child.on("exit", (code, signal) => {
      const err = new Error(
        `tap bridge exited (${code === null ? `signal=${signal ?? "unknown"}` : `code=${code}`})`,
      );
      this.child = null;
      this.readyReject?.(err);
      this.emit("close");
    });

    return this.readyPromise;
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.child?.stdout.pause();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.child?.stdout.resume();
  }

  writeFrame(frame: Buffer): boolean {
    const child = this.child;
    if (!child) return false;
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(frame.length, 0);
    const ok = child.stdin.write(Buffer.concat([header, frame]));
    if (!ok && !this.waitingDrain) {
      this.waitingDrain = true;
      child.stdin.once("drain", () => {
        this.waitingDrain = false;
        this.emit("drain");
      });
    }
    return ok;
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    while (this.stdoutBuffer.length >= 4) {
      const n = this.stdoutBuffer.readUInt32BE(0);
      if (this.stdoutBuffer.length < 4 + n) return;
      const frame = this.stdoutBuffer.subarray(4, 4 + n);
      this.stdoutBuffer = this.stdoutBuffer.subarray(4 + n);
      this.emit("frame", Buffer.from(frame));
    }
  }

  private handleStderr(chunk: Buffer): void {
    for (const raw of chunk.toString("utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line === "READY") {
        this.readyResolve?.();
        this.readyResolve = null;
        this.readyReject = null;
        continue;
      }
      if (line.startsWith("ERROR ")) {
        const err = new Error(line.slice(6));
        this.readyReject?.(err);
        this.emit("error", err);
        continue;
      }
      this.emit("log", line);
    }
  }
}
