import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import { promisify } from "node:util";
import type { ServerSettings, SystemCapacity } from "@leadfactory/schemas";

const execFileAsync = promisify(execFile);

export type WorkerLimits = {
  maxBrowsers: number;
  maxBrowserContexts: number;
  maxQwenConcurrency: number;
  maxDiscoveryConcurrency: number;
  maxAnalysisConcurrency: number;
  proxyRetryCount: number;
  maxPagesPerLead: number;
};

export type HealthStatus = "healthy" | "degraded" | "missing" | "unreachable";

export type ModuleHealth = {
  key: string;
  label: string;
  status: HealthStatus;
  version?: string;
  detail?: string;
};

export type ServerHealth = {
  checkedAt: string;
  capacity: SystemCapacity;
  modules: ModuleHealth[];
};

export async function probeSystemCapacity(storagePath = process.env.APP_STORAGE_DIR ?? process.cwd()): Promise<SystemCapacity> {
  const [cpuCores, memory, gpu, disk] = await Promise.all([
    readCpuCores(),
    readMemory(),
    readGpu(),
    readDiskUsage(storagePath)
  ]);
  const loadAverage1m = os.loadavg()[0];
  const cpuUsagePercent = Math.min(100, Math.round((loadAverage1m / cpuCores) * 1000) / 10);
  const usedMemoryBytes = Math.max(0, memory.totalMemoryBytes - memory.freeMemoryBytes);

  return {
    platform: os.platform(),
    cpuCores,
    loadAverage1m,
    cpuUsagePercent,
    totalMemoryBytes: memory.totalMemoryBytes,
    freeMemoryBytes: memory.freeMemoryBytes,
    usedMemoryBytes,
    memoryUsagePercent: Math.round((usedMemoryBytes / memory.totalMemoryBytes) * 1000) / 10,
    disk,
    gpu
  };
}

export async function probeServerHealth(params: {
  appStorageDir: string;
  databaseUrl: string;
  redisUrl: string;
  localLlmBaseUrl: string;
  rootDir: string;
}): Promise<ServerHealth> {
  const pythonExecutable = resolvePythonExecutable(params.rootDir);
  const browserWorkerDir = `${params.rootDir}/apps/worker-browser`;
  const [capacity, modules] = await Promise.all([
    probeSystemCapacity(),
    Promise.all([
      checkCommand("node", "Node.js", ["--version"]),
      checkCommand("pnpm", "pnpm", ["--version"]),
      checkDocker(),
      checkDockerCompose(),
      checkPython(pythonExecutable),
      checkPythonPackage(pythonExecutable, "camoufox", "Camoufox"),
      checkPythonPackage(pythonExecutable, "scrapy", "Scrapy"),
      checkNodePackage("playwright", "Playwright", browserWorkerDir),
      checkTcpService("postgres", "Postgres", params.databaseUrl, 5432),
      checkTcpService("redis", "Redis", params.redisUrl, 6379),
      checkQwen(params.localLlmBaseUrl)
    ])
  ]);

  return {
    checkedAt: new Date().toISOString(),
    capacity: {
      ...capacity,
      disk: await readDiskUsage(params.appStorageDir)
    },
    modules
  };
}

export function calculateWorkerLimits(params: {
  settings: ServerSettings;
  capacity: SystemCapacity;
  healthyProxyCount: number;
  qwenHealthy: boolean;
}): WorkerLimits {
  const { settings, capacity, healthyProxyCount, qwenHealthy } = params;
  const usage = settings.serverUsagePercent / 100;
  const usableCpuSlots = Math.max(1, Math.floor(capacity.cpuCores * usage));
  const availableMemory = capacity.freeMemoryBytes ?? Math.floor(capacity.totalMemoryBytes * 0.5);
  const memoryBrowserSlots = Math.max(1, Math.floor((availableMemory * usage) / (768 * 1024 * 1024)));
  const proxySlots = healthyProxyCount > 0 ? healthyProxyCount : 1;

  const maxBrowsers = Math.max(
    1,
    Math.min(settings.maxBrowsersHardCap, usableCpuSlots, memoryBrowserSlots, proxySlots)
  );

  const gpuBoost =
    capacity.gpu.available && (capacity.gpu.utilizationPercent ?? 100) < 75 ? 2 : 1;

  const maxQwenConcurrency = qwenHealthy
    ? Math.max(1, Math.min(settings.maxQwenConcurrency, Math.ceil(usableCpuSlots / 3) * gpuBoost))
    : 1;

  return {
    maxBrowsers,
    maxBrowserContexts: maxBrowsers,
    maxQwenConcurrency,
    maxDiscoveryConcurrency: Math.max(1, Math.floor(maxBrowsers * 0.75)),
    maxAnalysisConcurrency: maxQwenConcurrency,
    proxyRetryCount: settings.proxyRetryCount,
    maxPagesPerLead: settings.maxPagesPerLead
  };
}

async function readCpuCores(): Promise<number> {
  if (os.platform() === "linux") {
    const output = await runCommand("nproc", []);
    const parsed = Number(output?.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return os.cpus().length || 1;
}

async function readMemory(): Promise<{ totalMemoryBytes: number; freeMemoryBytes: number }> {
  if (os.platform() === "linux") {
    const output = await runCommand("free", ["-b"]);
    const memLine = output
      ?.split(/\r?\n/)
      .find((line) => line.trim().startsWith("Mem:"));

    if (memLine) {
      const columns = memLine.trim().split(/\s+/);
      const total = Number(columns[1]);
      const available = Number(columns[6] ?? columns[3]);
      if (Number.isFinite(total) && Number.isFinite(available)) {
        return { totalMemoryBytes: total, freeMemoryBytes: available };
      }
    }
  }

  return {
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem()
  };
}

async function readDiskUsage(pathToCheck: string): Promise<SystemCapacity["disk"]> {
  const output = await runCommand("df", ["-kP", pathToCheck]);
  const line = output?.split(/\r?\n/).filter(Boolean)[1];
  if (!line) return undefined;

  const columns = line.trim().split(/\s+/);
  const totalKiB = Number(columns[1]);
  const usedKiB = Number(columns[2]);
  const availableKiB = Number(columns[3]);
  const usage = Number(columns[4]?.replace("%", ""));

  if (![totalKiB, usedKiB, availableKiB, usage].every(Number.isFinite)) {
    return undefined;
  }

  return {
    path: pathToCheck,
    totalBytes: totalKiB * 1024,
    usedBytes: usedKiB * 1024,
    availableBytes: availableKiB * 1024,
    usagePercent: usage
  };
}

async function readGpu(): Promise<SystemCapacity["gpu"]> {
  const nvidiaSmiOutput = await runCommand("nvidia-smi", [
    "--query-gpu=name,memory.total,memory.used,utilization.gpu",
    "--format=csv,noheader,nounits"
  ]);

  if (nvidiaSmiOutput) {
    const gpu = parseNvidiaSmiGpu(nvidiaSmiOutput);
    if (gpu) return gpu;
  }

  const nvidiaProcGpu = await readNvidiaProcGpu();
  if (nvidiaProcGpu) return nvidiaProcGpu;

  const pciGpu = await readPciGpu();
  if (pciGpu) return pciGpu;

  const sysfsGpu = await readSysfsGpu();
  if (sysfsGpu) return sysfsGpu;

  return {
    available: false,
    detail: "No GPU visible inside this container. Expose the host GPU to the container for live metrics."
  };
}

function parseNvidiaSmiGpu(output: string): SystemCapacity["gpu"] | null {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const first = lines[0];
  if (!first) return null;

  const [name, total, used, utilization] = first.split(",").map((part) => part.trim());
  const totalMiB = finiteNumber(total);
  const usedMiB = finiteNumber(used);
  const utilizationPercent = finiteNumber(utilization);
  return {
    available: true,
    name: lines.length > 1 ? `${name} (+${lines.length - 1})` : name,
    memoryTotalMiB: totalMiB,
    memoryUsedMiB: usedMiB,
    utilizationPercent,
    detectionSource: "nvidia-smi"
  };
}

async function readNvidiaProcGpu(): Promise<SystemCapacity["gpu"] | null> {
  try {
    const gpuIds = await readdir("/proc/driver/nvidia/gpus");
    const firstGpuId = gpuIds[0];
    if (!firstGpuId) return null;

    const info = await readFile(`/proc/driver/nvidia/gpus/${firstGpuId}/information`, "utf8");
    const model = info.match(/^Model:\s*(.+)$/m)?.[1]?.trim();
    return {
      available: true,
      name: model || "NVIDIA GPU",
      detectionSource: "/proc/driver/nvidia",
      detail: "Detected by the NVIDIA Linux driver. Expose nvidia-smi for utilization and VRAM metrics."
    };
  } catch {
    return null;
  }
}

async function readPciGpu(): Promise<SystemCapacity["gpu"] | null> {
  const output = (await runCommand("lspci", ["-mm"])) ?? (await runCommand("lspci", []));
  if (!output) return null;

  const gpuLines = output.split(/\r?\n/).filter((line) => {
    return (
      /(VGA compatible controller|3D controller|Display controller)/i.test(line) &&
      /(NVIDIA|Advanced Micro Devices|AMD|Intel)/i.test(line)
    );
  });
  const first = gpuLines[0];
  if (!first) return null;

  const quoted = [...first.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  const vendor = quoted[1]?.replace("Advanced Micro Devices, Inc. [AMD/ATI]", "AMD");
  const model = quoted[2];
  const name = [vendor, model].filter(Boolean).join(" ").trim() || first.replace(/^[^\s]+\s+/, "").trim();

  return {
    available: true,
    name,
    detectionSource: "lspci",
    detail: "Detected by PCI scan. Expose nvidia-smi for utilization and VRAM metrics."
  };
}

async function readSysfsGpu(): Promise<SystemCapacity["gpu"] | null> {
  try {
    const entries = await readdir("/sys/bus/pci/devices");
    for (const entry of entries) {
      const deviceDir = `/sys/bus/pci/devices/${entry}`;
      const [vendorRaw, classRaw, deviceRaw] = await Promise.all([
        readFile(`${deviceDir}/vendor`, "utf8").catch(() => ""),
        readFile(`${deviceDir}/class`, "utf8").catch(() => ""),
        readFile(`${deviceDir}/device`, "utf8").catch(() => "")
      ]);
      const classCode = classRaw.trim().toLowerCase();
      const vendorId = vendorRaw.trim().toLowerCase();
      const isDisplayDevice = classCode.startsWith("0x03");
      if (!isDisplayDevice) continue;

      const vendorName = vendorNameFromPciId(vendorId);
      if (!vendorName) continue;

      return {
        available: true,
        name: `${vendorName} GPU ${deviceRaw.trim()}`.trim(),
        detectionSource: "/sys/bus/pci",
        detail: "Detected by Linux sysfs. Expose nvidia-smi for utilization and VRAM metrics."
      };
    }
  } catch {
    return null;
  }

  return null;
}

function finiteNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function vendorNameFromPciId(vendorId: string): string | null {
  if (vendorId === "0x10de") return "NVIDIA";
  if (vendorId === "0x1002") return "AMD";
  if (vendorId === "0x8086") return "Intel";
  return null;
}

async function runCommand(command: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync(command, args, { timeout: 5000 });
    return result.stdout;
  } catch {
    return null;
  }
}

async function runCommandResult(
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number }
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options?.cwd,
      timeout: options?.timeout ?? 5000
    });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: failure.stdout?.trim() ?? "",
      stderr: failure.stderr?.trim() ?? failure.message ?? ""
    };
  }
}

async function checkCommand(
  key: string,
  label: string,
  args: string[]
): Promise<ModuleHealth> {
  const result = await runCommandResult(key, args);
  if (!result.ok) {
    return { key, label, status: "missing", detail: result.stderr || "Command not found" };
  }

  return {
    key,
    label,
    status: "healthy",
    version: firstLine(result.stdout || result.stderr)
  };
}

async function checkDocker(): Promise<ModuleHealth> {
  const result = await runCommandResult("docker", ["info"], { timeout: 8000 });
  if (!result.ok) {
    return {
      key: "docker",
      label: "Docker daemon",
      status: "unreachable",
      detail: result.stderr || "Docker is installed but the daemon is not reachable"
    };
  }

  return { key: "docker", label: "Docker daemon", status: "healthy" };
}

async function checkDockerCompose(): Promise<ModuleHealth> {
  const plugin = await runCommandResult("docker", ["compose", "version"]);
  if (plugin.ok) {
    return {
      key: "docker-compose",
      label: "Docker Compose",
      status: "healthy",
      version: firstLine(plugin.stdout)
    };
  }

  const standalone = await runCommandResult("docker-compose", ["--version"]);
  if (standalone.ok) {
    return {
      key: "docker-compose",
      label: "Docker Compose",
      status: "healthy",
      version: firstLine(standalone.stdout)
    };
  }

  return {
    key: "docker-compose",
    label: "Docker Compose",
    status: "missing",
    detail: plugin.stderr || standalone.stderr || "docker compose not found"
  };
}

async function checkPython(pythonExecutable: string): Promise<ModuleHealth> {
  const python3 = await runCommandResult(pythonExecutable, ["--version"]);
  if (python3.ok) {
    return {
      key: "python",
      label: "Python",
      status: "healthy",
      version: firstLine(python3.stdout || python3.stderr)
    };
  }

  return {
    key: "python",
    label: "Python",
    status: "missing",
    detail: python3.stderr || `${pythonExecutable} not found`
  };
}

async function checkPythonPackage(
  pythonExecutable: string,
  packageName: string,
  label: string
): Promise<ModuleHealth> {
  const code = `import ${packageName}; import importlib.metadata as m; print(m.version("${packageName}"))`;
  const result = await runCommandResult(pythonExecutable, ["-c", code]);

  if (!result.ok) {
    return {
      key: packageName,
      label,
      status: "missing",
      detail: `Python package ${packageName} is not installed`
    };
  }

  return {
    key: packageName,
    label,
    status: "healthy",
    version: firstLine(result.stdout)
  };
}

async function checkNodePackage(
  packageName: string,
  label: string,
  cwd: string
): Promise<ModuleHealth> {
  const result = await runCommandResult(
    "node",
    ["-e", `console.log(require("${packageName}/package.json").version)`],
    { cwd }
  );

  if (!result.ok) {
    return {
      key: packageName,
      label,
      status: "missing",
      detail: `Node package ${packageName} is not installed`
    };
  }

  return {
    key: packageName,
    label,
    status: "healthy",
    version: firstLine(result.stdout)
  };
}

async function checkTcpService(
  key: string,
  label: string,
  urlValue: string,
  defaultPort: number
): Promise<ModuleHealth> {
  try {
    const parsed = new URL(urlValue);
    const host = parsed.hostname || "localhost";
    const port = Number(parsed.port || defaultPort);
    const reachable = await canConnect(host, port, 1500);

    return {
      key,
      label,
      status: reachable ? "healthy" : "unreachable",
      detail: `${host}:${port}`
    };
  } catch (error) {
    return {
      key,
      label,
      status: "degraded",
      detail: error instanceof Error ? error.message : "Invalid service URL"
    };
  }
}

async function checkQwen(baseUrl: string): Promise<ModuleHealth> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      return {
        key: "qwen",
        label: "Local Qwen endpoint",
        status: "unreachable",
        detail: `${response.status} ${response.statusText}`
      };
    }

    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    return {
      key: "qwen",
      label: "Local Qwen endpoint",
      status: "healthy",
      detail: `${body.data?.length ?? 0} models available`
    };
  } catch (error) {
    return {
      key: "qwen",
      label: "Local Qwen endpoint",
      status: "unreachable",
      detail: error instanceof Error ? error.message : "LLM endpoint did not respond"
    };
  }
}

async function canConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/).find(Boolean)?.trim();
}

function resolvePythonExecutable(rootDir: string): string {
  const venvPython = `${rootDir}/.venv/bin/python`;
  if (existsSync(venvPython)) return venvPython;
  if (process.env.LEADFACTORY_PYTHON) return process.env.LEADFACTORY_PYTHON;
  return "python3";
}
