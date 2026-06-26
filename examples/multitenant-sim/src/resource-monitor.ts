import https from "node:https";
import fs from "node:fs";

import type { SimulatorConfig } from "./config.ts";

const SERVICE_HOST = process.env.KUBERNETES_SERVICE_HOST;
const SERVICE_PORT = process.env.KUBERNETES_SERVICE_PORT ?? "443";
const TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
const CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";

export type ResourceSnapshot = {
  /** Sample timestamp in Unix `ms` */
  at: number;
  /** Whether Kubernetes metrics are available */
  available: boolean;
  /** Data source label */
  source: "kubernetes" | "unavailable";
  /** Error detail when unavailable */
  error?: string;
  pod: {
    /** Pod namespace */
    namespace: string | null;
    /** Pod name */
    name: string | null;
    /** Scheduled node name */
    nodeName: string | null;
    /** Container restart count */
    restartCount: number | null;
    /** Pod phase */
    phase: string | null;
  };
  cpu: {
    /** Live CPU usage in `millicores` */
    usageMillicores: number | null;
    /** CPU request in `millicores` */
    requestMillicores: number | null;
    /** CPU limit in `millicores` */
    limitMillicores: number | null;
  };
  memory: {
    /** Live memory usage in `bytes` */
    usageBytes: number | null;
    /** Memory request in `bytes` */
    requestBytes: number | null;
    /** Memory limit in `bytes` */
    limitBytes: number | null;
  };
  storage: {
    /** Live pod ephemeral storage usage in `bytes` */
    usageBytes: number | null;
    /** Ephemeral storage request in `bytes` */
    requestBytes: number | null;
    /** Ephemeral storage limit in `bytes` */
    limitBytes: number | null;
    /** Container writable layer usage in `bytes` */
    rootfsBytes: number | null;
    /** Container log usage in `bytes` */
    logsBytes: number | null;
    /** Pod volume usage samples */
    volumes: VolumeDiskSnapshot[];
  };
  node: {
    /** Scheduled node name */
    name: string | null;
    /** Node filesystem usage sample */
    filesystem: DiskSnapshot;
    /** Container image filesystem usage sample */
    imageFilesystem: DiskSnapshot;
  };
  vms: {
    /** Active or starting VM slots */
    activeSlots: number;
    /** Configured VM slot ceiling */
    configuredSlots: number;
    /** Guest memory per VM in `bytes` */
    guestMemoryBytesEach: number | null;
    /** Configured guest RAM budget for active slots in `bytes` */
    estimatedGuestMemoryBytes: number | null;
  };
};

export type DiskSnapshot = {
  /** Available space in `bytes` */
  availableBytes: number | null;
  /** Total capacity in `bytes` */
  capacityBytes: number | null;
  /** Used space in `bytes` */
  usedBytes: number | null;
};

export type VolumeDiskSnapshot = DiskSnapshot & {
  /** Volume name */
  name: string;
};

type KubePod = {
  metadata?: { name?: string; namespace?: string };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      restartCount?: number;
    }>;
  };
  spec?: {
    nodeName?: string;
    containers?: Array<{
      name?: string;
      resources?: {
        requests?: Record<string, string>;
        limits?: Record<string, string>;
      };
    }>;
  };
};

type PodMetrics = {
  containers?: Array<{
    name?: string;
    usage?: Record<string, string>;
  }>;
};

type KubeFsStats = {
  availableBytes?: number;
  capacityBytes?: number;
  usedBytes?: number;
};

type KubeVolumeStats = KubeFsStats & {
  name?: string;
};

type KubePodStats = {
  podRef?: {
    namespace?: string;
    name?: string;
  };
  containers?: Array<{
    name?: string;
    rootfs?: KubeFsStats;
    logs?: KubeFsStats;
  }>;
  "ephemeral-storage"?: KubeFsStats;
  volume?: KubeVolumeStats[];
};

type KubeNodeStatsSummary = {
  node?: {
    fs?: KubeFsStats;
    runtime?: {
      imageFs?: KubeFsStats;
    };
  };
  pods?: KubePodStats[];
};

export class ResourceMonitor {
  private readonly namespace: string | null;
  private readonly podName: string | null;
  private readonly containerName: string;
  private readonly guestMemoryBytesEach: number | null;

  constructor(config: SimulatorConfig) {
    this.namespace = process.env.KUBE_NAMESPACE ?? null;
    this.podName = process.env.KUBE_POD_NAME ?? null;
    this.containerName = process.env.KUBE_CONTAINER_NAME ?? "simulator";
    this.guestMemoryBytesEach = parseByteQuantity(config.vmMemory);
  }

  async sample(input: {
    activeSlots: number;
    configuredSlots: number;
  }): Promise<ResourceSnapshot> {
    const base = this.emptySnapshot(input);
    if (!SERVICE_HOST || !this.namespace || !this.podName) {
      return {
        ...base,
        error: "Kubernetes service metadata is unavailable",
      };
    }

    try {
      const [pod, metrics] = await Promise.all([
        kubeJson<KubePod>(
          `/api/v1/namespaces/${encodeURIComponent(this.namespace)}/pods/${encodeURIComponent(this.podName)}`,
        ),
        kubeJson<PodMetrics>(
          `/apis/metrics.k8s.io/v1beta1/namespaces/${encodeURIComponent(this.namespace)}/pods/${encodeURIComponent(this.podName)}`,
        ).catch(() => null),
      ]);
      const nodeName = pod.spec?.nodeName ?? null;
      const nodeStats = nodeName
        ? await kubeJson<KubeNodeStatsSummary>(
            `/api/v1/nodes/${encodeURIComponent(nodeName)}/proxy/stats/summary`,
          ).catch(() => null)
        : null;

      const podContainer = pod.spec?.containers?.find(
        (c) => c.name === this.containerName,
      );
      const metricContainer = metrics?.containers?.find(
        (c) => c.name === this.containerName,
      );
      const status = pod.status?.containerStatuses?.find(
        (c) => c.name === this.containerName,
      );
      const podStats = nodeStats?.pods?.find(
        (p) =>
          p.podRef?.namespace === this.namespace &&
          p.podRef?.name === this.podName,
      );
      const containerStats = podStats?.containers?.find(
        (c) => c.name === this.containerName,
      );

      return {
        ...base,
        available: true,
        source: "kubernetes",
        pod: {
          namespace: pod.metadata?.namespace ?? this.namespace,
          name: pod.metadata?.name ?? this.podName,
          nodeName,
          restartCount: status?.restartCount ?? null,
          phase: pod.status?.phase ?? null,
        },
        cpu: {
          usageMillicores: parseCpuQuantity(metricContainer?.usage?.cpu),
          requestMillicores: parseCpuQuantity(
            podContainer?.resources?.requests?.cpu,
          ),
          limitMillicores: parseCpuQuantity(podContainer?.resources?.limits?.cpu),
        },
        memory: {
          usageBytes: parseByteQuantity(metricContainer?.usage?.memory),
          requestBytes: parseByteQuantity(
            podContainer?.resources?.requests?.memory,
          ),
          limitBytes: parseByteQuantity(podContainer?.resources?.limits?.memory),
        },
        storage: {
          usageBytes: statBytes(podStats?.["ephemeral-storage"]?.usedBytes),
          requestBytes: parseByteQuantity(
            podContainer?.resources?.requests?.["ephemeral-storage"],
          ),
          limitBytes: parseByteQuantity(
            podContainer?.resources?.limits?.["ephemeral-storage"],
          ),
          rootfsBytes: statBytes(containerStats?.rootfs?.usedBytes),
          logsBytes: statBytes(containerStats?.logs?.usedBytes),
          volumes: volumeSnapshots(podStats?.volume),
        },
        node: {
          name: nodeName,
          filesystem: diskSnapshot(nodeStats?.node?.fs),
          imageFilesystem: diskSnapshot(nodeStats?.node?.runtime?.imageFs),
        },
      };
    } catch (err) {
      return {
        ...base,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private emptySnapshot(input: {
    activeSlots: number;
    configuredSlots: number;
  }): ResourceSnapshot {
    return {
      at: Date.now(),
      available: false,
      source: "unavailable",
      pod: {
        namespace: this.namespace,
        name: this.podName,
        nodeName: null,
        restartCount: null,
        phase: null,
      },
      cpu: {
        usageMillicores: null,
        requestMillicores: null,
        limitMillicores: null,
      },
      memory: {
        usageBytes: null,
        requestBytes: null,
        limitBytes: null,
      },
      storage: {
        usageBytes: null,
        requestBytes: null,
        limitBytes: null,
        rootfsBytes: null,
        logsBytes: null,
        volumes: [],
      },
      node: {
        name: null,
        filesystem: emptyDiskSnapshot(),
        imageFilesystem: emptyDiskSnapshot(),
      },
      vms: {
        activeSlots: input.activeSlots,
        configuredSlots: input.configuredSlots,
        guestMemoryBytesEach: this.guestMemoryBytesEach,
        estimatedGuestMemoryBytes:
          this.guestMemoryBytesEach === null
            ? null
            : input.activeSlots * this.guestMemoryBytesEach,
      },
    };
  }
}

function emptyDiskSnapshot(): DiskSnapshot {
  return {
    availableBytes: null,
    capacityBytes: null,
    usedBytes: null,
  };
}

function diskSnapshot(stats: KubeFsStats | undefined): DiskSnapshot {
  if (!stats) return emptyDiskSnapshot();
  return {
    availableBytes: statBytes(stats.availableBytes),
    capacityBytes: statBytes(stats.capacityBytes),
    usedBytes: statBytes(stats.usedBytes),
  };
}

function volumeSnapshots(
  volumes: KubeVolumeStats[] | undefined,
): VolumeDiskSnapshot[] {
  return [...(volumes ?? [])]
    .map((volume) => ({
      name: volume.name ?? "unknown",
      ...diskSnapshot(volume),
    }))
    .sort((a, b) => (b.usedBytes ?? 0) - (a.usedBytes ?? 0));
}

function statBytes(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function kubeJson<T>(path: string): Promise<T> {
  const token = fs.readFileSync(TOKEN_PATH, "utf8").trim();
  const ca = fs.existsSync(CA_PATH) ? fs.readFileSync(CA_PATH) : undefined;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: SERVICE_HOST,
        port: Number(SERVICE_PORT),
        path,
        method: "GET",
        ca,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Kubernetes API ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(5_000, () => {
      req.destroy(new Error("Kubernetes API timeout"));
    });
    req.end();
  });
}

export function parseCpuQuantity(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.endsWith("n")) {
    return Number(trimmed.slice(0, -1)) / 1_000_000;
  }
  if (trimmed.endsWith("u")) {
    return Number(trimmed.slice(0, -1)) / 1_000;
  }
  if (trimmed.endsWith("m")) {
    return Number(trimmed.slice(0, -1));
  }
  const cores = Number(trimmed);
  return Number.isFinite(cores) ? cores * 1000 : null;
}

export function parseByteQuantity(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const match = /^([0-9]+(?:\.[0-9]+)?)([EPTGMK]i?|[eptgmk])?$/.exec(trimmed);
  if (!match) return null;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;

  const suffix = match[2] ?? "";
  const decimal: Record<string, number> = {
    k: 1e3,
    K: 1e3,
    m: 1e6,
    M: 1e6,
    g: 1e9,
    G: 1e9,
    t: 1e12,
    T: 1e12,
    p: 1e15,
    P: 1e15,
    e: 1e18,
    E: 1e18,
  };
  const binary: Record<string, number> = {
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    Pi: 1024 ** 5,
    Ei: 1024 ** 6,
  };

  const multiplier = binary[suffix] ?? decimal[suffix] ?? 1;
  return Math.round(amount * multiplier);
}
