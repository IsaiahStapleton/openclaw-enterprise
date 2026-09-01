import { PassThrough, Writable } from "node:stream";
import { createKubernetesClientConfiguration } from "../../kubernetes/client.ts";

const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;

type KubernetesAuthentication =
  | { readonly mode: "inCluster" }
  | { readonly mode: "kubeconfig"; readonly kubeconfigPath: string; readonly context: string };

type ValidationFailure = (message: string) => Error;
type KubernetesClientConfigurationFactory = typeof createKubernetesClientConfiguration;
type KubernetesClientConfigurationResult = Awaited<
  ReturnType<KubernetesClientConfigurationFactory>
>;
type KubernetesExecWebSocket = Awaited<ReturnType<import("@kubernetes/client-node").Exec["exec"]>>;
type KubernetesExecInstance = {
  exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: string | string[],
    stdout: Writable | null,
    stderr: Writable | null,
    stdin: NodeJS.ReadableStream | null,
    tty: boolean,
    statusCallback?: (status: import("@kubernetes/client-node").V1Status) => void,
  ): Promise<KubernetesExecWebSocket>;
};

interface KubernetesClientNodePodExecutorDependencies {
  readonly createClientConfiguration?: KubernetesClientConfigurationFactory;
  readonly createExec?: (
    sdk: KubernetesClientConfigurationResult["sdk"],
    kubeConfig: KubernetesClientConfigurationResult["kubeConfig"],
  ) => KubernetesExecInstance;
}

interface KubernetesPodExecInput {
  readonly namespace: string;
  readonly podName: string;
  readonly containerName: string;
  readonly command: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly outputLimitBytes?: number;
  readonly signal?: AbortSignal;
}

class CollectingWritable extends Writable {
  private readonly chunks: Buffer[] = [];
  private readonly limitBytes: number;
  private bytes = 0;

  constructor(limitBytes = DEFAULT_OUTPUT_LIMIT_BYTES) {
    super();
    this.limitBytes = limitBytes;
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.bytes + buffer.byteLength > this.limitBytes) {
      callback(new Error("Kubernetes Pod exec output exceeded limit."));
      return;
    }
    this.bytes += buffer.byteLength;
    this.chunks.push(buffer);
    callback();
  }

  readText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

export class KubernetesClientNodePodExecutor {
  private readonly authentication: KubernetesAuthentication;
  private readonly dependencies: Required<KubernetesClientNodePodExecutorDependencies>;
  private readonly validationFailure: ValidationFailure;

  constructor(
    authentication: KubernetesAuthentication,
    validationFailure: ValidationFailure,
    dependencies: KubernetesClientNodePodExecutorDependencies = {},
  ) {
    this.authentication = authentication;
    this.dependencies = {
      createClientConfiguration:
        dependencies.createClientConfiguration ?? createKubernetesClientConfiguration,
      createExec: dependencies.createExec ?? ((sdk, kubeConfig) => new sdk.Exec(kubeConfig)),
    };
    this.validationFailure = validationFailure;
  }

  async exec(input: KubernetesPodExecInput): Promise<{
    readonly stdout: string;
    readonly stderr: string;
    readonly status: import("@kubernetes/client-node").V1Status;
  }> {
    if (input.signal?.aborted === true) {
      throw new Error("Kubernetes Pod exec aborted.");
    }

    const { sdk, kubeConfig } = await this.dependencies.createClientConfiguration(
      this.authentication,
      this.validationFailure,
    );
    const executor = this.dependencies.createExec(sdk, kubeConfig);
    const stdout = new CollectingWritable(input.outputLimitBytes);
    const stderr = new CollectingWritable(input.outputLimitBytes);
    const stdin = new PassThrough();
    const timeout = AbortSignal.timeout(input.timeoutMs);
    const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);

    let settled = false;
    let statusReceived = false;
    let websocket: KubernetesExecWebSocket | undefined;
    const closedWebSockets = new Set<KubernetesExecWebSocket>();
    let removeWebSocketListeners = () => {};
    let removeAbortListener = () => {};
    let removeOutputListeners = () => {};

    const closeWebSocket = (socket = websocket): void => {
      if (socket === undefined) return;
      if (closedWebSockets.has(socket)) return;
      closedWebSockets.add(socket);
      try {
        socket.terminate();
      } catch {
        // Cleanup must not replace the sanitized execution outcome.
      }
    };

    let statusResult: (result: import("@kubernetes/client-node").V1Status) => void = () => {};
    const status = new Promise<import("@kubernetes/client-node").V1Status>((resolve) => {
      statusResult = resolve;
    });
    const websocketClosed = new Promise<never>((_, reject) => {
      const attach = (socket: KubernetesExecWebSocket) => {
        const onClose = () => {
          if (!statusReceived && !settled) {
            reject(new Error("Kubernetes Pod exec closed before status."));
          }
        };
        const onError = () => {
          if (!statusReceived && !settled) {
            reject(new Error("Kubernetes Pod exec websocket error."));
          }
        };
        socket.on("close", onClose);
        socket.on("error", onError);
        removeWebSocketListeners = () => {
          socket.off("close", onClose);
          socket.off("error", onError);
        };
      };

      const status = executor.exec(
        input.namespace,
        input.podName,
        input.containerName,
        [...input.command],
        stdout,
        stderr,
        stdin,
        false,
        (result) => {
          statusReceived = true;
          statusResult(result);
        },
      );
      status
        .then((socket) => {
          websocket = socket;
          if (settled || signal.aborted) {
            closeWebSocket(socket);
            return;
          }
          attach(socket);
        })
        .catch(() => reject(new Error("Kubernetes Pod exec failed to start.")));
    });
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => {
        removeWebSocketListeners();
        reject(createAbortError(input.signal, timeout));
        closeWebSocket();
        stdin.destroy();
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    });
    const outputFailed = new Promise<never>((_, reject) => {
      const onError = (error: Error) => {
        removeWebSocketListeners();
        reject(error);
        closeWebSocket();
        stdin.destroy();
      };
      stdout.once("error", onError);
      stderr.once("error", onError);
      removeOutputListeners = () => {
        stdout.off("error", onError);
        stderr.off("error", onError);
      };
    });

    try {
      stdin.end(input.stdin);
      const result = await Promise.race([status, aborted, outputFailed, websocketClosed]);
      if (result.status !== "Success") {
        throw new Error("Kubernetes Pod exec failed.");
      }
      return { stdout: stdout.readText(), stderr: stderr.readText(), status: result };
    } catch (error) {
      if (isSanitizedPodExecError(error)) throw error;
      throw new Error("Kubernetes Pod exec failed.");
    } finally {
      settled = true;
      removeAbortListener();
      removeOutputListeners();
      removeWebSocketListeners();
      closeWebSocket();
      stdin.destroy();
    }
  }
}

function createAbortError(inputSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): Error {
  if (timeoutSignal.aborted && inputSignal?.aborted !== true) {
    return new Error("Kubernetes Pod exec timed out.");
  }
  return new Error("Kubernetes Pod exec aborted.");
}

function isSanitizedPodExecError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    [
      "Kubernetes Pod exec aborted.",
      "Kubernetes Pod exec closed before status.",
      "Kubernetes Pod exec failed.",
      "Kubernetes Pod exec failed to start.",
      "Kubernetes Pod exec output exceeded limit.",
      "Kubernetes Pod exec timed out.",
      "Kubernetes Pod exec websocket error.",
    ].includes(error.message)
  );
}
