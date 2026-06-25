# SDK: Network, Ingress, and SSH

The Firecracker runtime disables guest egress networking by default. Passing
`httpHooks`, DNS overrides, mapped TCP, outbound SSH proxying, or
`sandbox.netEnabled: true` enables mediated TAP egress.

## Mediated Guest Egress

```ts
import { VM, createHttpHooks } from "@earendil-works/gondolin";

const { httpHooks, env } = createHttpHooks({
  allowedHosts: ["api.github.com"],
  secrets: {
    GITHUB_TOKEN: {
      hosts: ["api.github.com"],
      value: process.env.GITHUB_TOKEN,
    },
  },
});

const vm = await VM.create({ httpHooks, env });
await vm.exec(
  'curl -H "Authorization: Bearer $GITHUB_TOKEN" https://api.github.com/user',
);
await vm.close();
```

Host requirements for mediated egress are listed in [Network](./network.md).

## Host-To-Guest Features

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
