# Secrets

The Firecracker runtime has no mediated guest egress path. Do not pass real
secrets into guest environment variables or files unless the workload is allowed
to read them.

`createHttpHooks()` remains exported for callers that want to build host-side
HTTP policy objects, but VM creation rejects `httpHooks` because guest egress is
disabled.

For production workloads:

- keep credentials in the host process
- move data into the VM through VFS mounts or stdin only when the guest is
  allowed to see it
- use host-side services for outbound API calls
- use Kubernetes or host network policy for the Node.js process itself
