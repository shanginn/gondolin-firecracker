# SDK: Network, Ingress, and SSH

The Firecracker runtime disables guest egress networking. `httpHooks`, DNS
overrides, mapped TCP, outbound SSH proxying, and `netEnabled: true` are
rejected.

Supported network features are host-to-guest:

- `vm.enableIngress()` exposes guest HTTP services on the host.
- `vm.enableSsh()` exposes guest SSH on a host-local TCP port.

## `vm.enableIngress()`

```ts
import { VM } from "@earendil-works/gondolin";

const vm = await VM.create();
const ingress = await vm.enableIngress({
  listenHost: "127.0.0.1",
  listenPort: 0,
});

vm.setIngressRoutes([{ prefix: "/", port: 8000, stripPrefix: true }]);

const server = vm.exec(["/bin/sh", "-lc", "python -m http.server 8000"], {
  buffer: false,
  stdout: "inherit",
  stderr: "inherit",
});

console.log(ingress.url);

await ingress.close();
await vm.close();
```

Ingress requires the default `/etc/gondolin` mount.

## `vm.enableSsh()`

```ts
const vm = await VM.create();
const ssh = await vm.enableSsh({
  listenHost: "127.0.0.1",
  listenPort: 0,
  user: "root",
});

console.log(ssh.command);

await ssh.close();
await vm.close();
```

The guest image must include `sshd` and the `sandboxssh` helper.
