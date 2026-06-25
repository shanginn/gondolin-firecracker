# Secrets

Do not pass real secrets into guest environment variables or files unless the
workload is allowed to read them.

For policy-mediated HTTP(S) egress, use `createHttpHooks()`. The guest receives
placeholder values, and the host substitutes real secrets only for allowed
destinations.

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
```

For production workloads:

- keep credentials in the host process
- scope each secret to the smallest host allowlist
- keep URL query secret replacement disabled unless it is required
- use Kubernetes or host network policy for the Gondolin process itself
