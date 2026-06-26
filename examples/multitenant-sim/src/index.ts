import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { readSimulatorConfig } from "./config.ts";
import { createSimulatorServer } from "./server.ts";

const config = readSimulatorConfig();
const { server, simulator } = await createSimulatorServer(config);

server.listen(config.port, config.host);
await once(server, "listening");
simulator.startLoop();

const address = server.address() as AddressInfo;
console.log(
  JSON.stringify({
    message: "gondolin user simulator listening",
    url: `http://${address.address}:${address.port}`,
    backend: config.backend,
    pausedOnStart: config.pausedOnStart,
    maxActiveUsers: config.maxActiveUsers,
    maxActiveVms: config.maxActiveVms,
  }),
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ message: "shutting down", signal }));
  simulator.stopLoop();
  server.close();
  await simulator.reset();
}

process.on("SIGINT", () => {
  void shutdown("SIGINT").finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => process.exit(0));
});
