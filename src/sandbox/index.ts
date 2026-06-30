/**
 * Kubernetes Sandbox Provider
 *
 * Maps a Mastra workspace onto a kubernetes-sigs/agent-sandbox `Sandbox`
 * (a singleton stateful pod + PVCs) in a tenant namespace. This package is a
 * thin client: the agent-sandbox controller owns reconciliation, suspend on
 * `shutdownTime` expiry, and cascade deletion. Idle handling is a sliding
 * `shutdownTime` this client bumps on activity.
 *
 * @see https://github.com/kubernetes-sigs/agent-sandbox
 */

import { CustomObjectsApi, CoreV1Api, KubeConfig, PatchStrategy, setHeaderOptions } from '@kubernetes/client-node';
import type { V1Pod, V1PodTemplateSpec } from '@kubernetes/client-node';
import type { RequestContext } from '@mastra/core/di';
import type {
  CommandResult,
  ExecuteCommandOptions,
  MastraSandboxOptions,
  ProviderStatus,
  SandboxInfo,
} from '@mastra/core/workspace';
import { MastraSandbox, SandboxError, SandboxNotReadyError } from '@mastra/core/workspace';
import type { KubernetesAuthOptions, CredentialProvider } from './auth';
import { createCredentialProvider } from './auth';
import { KubernetesProcessManager } from './process-manager';

const LOG_PREFIX = '[KubernetesSandbox]';

export const SANDBOX_GROUP = 'agents.x-k8s.io';
export const SANDBOX_VERSION = 'v1alpha1';
export const SANDBOX_PLURAL = 'sandboxes';
export const TEMPLATE_GROUP = 'extensions.agents.x-k8s.io';
export const TEMPLATE_VERSION = 'v1alpha1';
export const TEMPLATE_PLURAL = 'sandboxtemplates';
export const CLAIM_GROUP = 'extensions.agents.x-k8s.io';
export const CLAIM_VERSION = 'v1alpha1';
export const CLAIM_PLURAL = 'sandboxclaims';

/** Default tenant-namespace pattern: per-user namespaces (`user-<oidc sub>`). */
export const DEFAULT_NAMESPACE_PATTERN = /^user-[0-9a-f-]+$/;

type InstructionsOption = string | ((opts: { defaultInstructions: string; requestContext?: RequestContext }) => string);

interface SandboxTemplateSpec {
  podTemplate: V1PodTemplateSpec;
  volumeClaimTemplates?: unknown[];
}

interface SandboxResource {
  apiVersion: string;
  kind: 'Sandbox';
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    podTemplate: V1PodTemplateSpec;
    volumeClaimTemplates?: unknown[];
    replicas?: number;
    shutdownTime?: string;
    shutdownPolicy?: 'Retain' | 'Delete';
  };
  status?: {
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
    podIPs?: string[];
  };
}

interface SandboxClaimResource {
  apiVersion: string;
  kind: 'SandboxClaim';
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };
  spec: {
    sandboxTemplateRef: { name: string };
    additionalPodMetadata?: {
      labels?: Record<string, string>;
      annotations?: Record<string, string>;
    };
    lifecycle?: {
      shutdownTime?: string;
      shutdownPolicy?: 'Retain' | 'Delete' | 'DeleteForeground';
    };
    warmpool?: string;
  };
  status?: {
    conditions?: Array<{ type: string; status: string; reason?: string; message?: string }>;
    sandbox?: {
      name?: string;
      podIPs?: string[];
    };
  };
}

export interface KubernetesSandboxOptions extends Omit<MastraSandboxOptions, 'processes'> {
  /** Stable identifier; the SandboxClaim object is named `ws-<id>`. */
  id?: string;
  /** Tenant namespace the Sandbox lives in (e.g. `user-<oidc sub>`). */
  namespace: string;
  /**
   * Name of the platform-owned SandboxTemplate in the tenant namespace to
   * stamp the Sandbox from. The template must pin a `serviceAccountName`.
   */
  sandboxTemplateName: string;
  /** Credential strategy. Zero-trust default is `tokenExchange`. */
  auth: KubernetesAuthOptions;
  /**
   * Sliding idle window in seconds. Every activity pushes `shutdownTime`
   * this far into the future; on expiry the agent-sandbox controller
   * suspends the pod (PVCs persist).
   * @default 3600
   */
  idleTimeoutSeconds?: number;
  /** Working directory for commands. @default '/workspace' */
  workingDir?: string;
  /** Container to exec into. Defaults to the template's first container. */
  containerName?: string;
  /** Default command timeout in milliseconds. @default 300_000 */
  timeout?: number;
  /** Extra environment for commands (exec-time, not pod env). */
  env?: Record<string, string>;
  /** Extra labels for the Sandbox object. */
  labels?: Record<string, string>;
  /** Extra annotations for the Sandbox object (e.g. agent/thread ids). */
  annotations?: Record<string, string>;
  /**
   * Resource to create. `sandboxClaim` is the platform path: the
   * agent-sandbox extensions controller owns the concrete Sandbox/Pod.
   * `sandbox` is retained for migration tests and emergency fallback only.
   * @default 'sandboxClaim'
   */
  resourceMode?: 'sandboxClaim' | 'sandbox';
  /** Optional warm pool name for SandboxClaim scheduling. */
  warmpool?: string;
  /**
   * Pattern the tenant namespace must match. Defense-in-depth only — real
   * enforcement is apiserver RBAC on the user-derived credential.
   * @default /^user-[0-9a-f-]+$/
   */
  namespacePattern?: RegExp;
  /** Pod readiness timeout in ms (volume attach can take a minute). @default 300_000 */
  readyTimeoutMs?: number;
  /** Override instructions returned by getInstructions(). */
  instructions?: InstructionsOption;
}

export class KubernetesSandbox extends MastraSandbox {
  readonly id: string;
  readonly name = 'KubernetesSandbox';
  readonly provider = 'kubernetes';
  status: ProviderStatus = 'pending';

  declare readonly processes: KubernetesProcessManager;

  readonly namespace: string;
  readonly workingDir: string;

  private readonly _templateName: string;
  private readonly _credentials: CredentialProvider;
  private readonly _idleTimeoutS: number;
  private readonly _readyTimeoutMs: number;
  private readonly _labels: Record<string, string>;
  private readonly _annotations: Record<string, string>;
  private readonly _resourceMode: 'sandboxClaim' | 'sandbox';
  private readonly _warmpool: string | undefined;
  private readonly _instructionsOverride?: InstructionsOption;
  private _containerName: string | undefined;
  private _lastActivityBumpMs = 0;
  private _templateImage: string | undefined;
  private _sandboxName: string | undefined;

  constructor(options: KubernetesSandboxOptions) {
    const processes = new KubernetesProcessManager({
      env: options.env ?? {},
      defaultTimeout: options.timeout ?? 300_000,
    });
    super({ ...options, name: 'KubernetesSandbox', processes });

    const pattern = options.namespacePattern ?? DEFAULT_NAMESPACE_PATTERN;
    if (!pattern.test(options.namespace)) {
      throw new SandboxError(
        `${LOG_PREFIX} namespace '${options.namespace}' does not match the tenant namespace pattern ${pattern}.`,
        'INVALID',
        { namespace: options.namespace },
      );
    }

    this.id = options.id ?? this._generateId();
    this.namespace = options.namespace;
    this.workingDir = options.workingDir ?? '/workspace';
    this._templateName = options.sandboxTemplateName;
    this._credentials = createCredentialProvider(options.auth);
    this._idleTimeoutS = options.idleTimeoutSeconds ?? 3600;
    this._readyTimeoutMs = options.readyTimeoutMs ?? 300_000;
    this._containerName = options.containerName;
    this._resourceMode = options.resourceMode ?? 'sandboxClaim';
    this._warmpool = options.warmpool;
    this._instructionsOverride = options.instructions;
    this._labels = {
      'app.kubernetes.io/managed-by': 'mastra',
      'appmana.com/workspace-id': this.id,
      ...options.labels,
    };
    this._annotations = { ...options.annotations };

    processes.attach(this);
  }

  /** The SandboxClaim object name, and the direct Sandbox name in resourceMode=sandbox. */
  get sandboxName(): string {
    return `ws-${this.id}`;
  }

  /** The concrete Sandbox object name created for this workspace. */
  get runtimeSandboxName(): string {
    return this._sandboxName ?? this.sandboxName;
  }

  /** The pod name (agent-sandbox names the pod after the concrete Sandbox). */
  get podName(): string {
    return this.runtimeSandboxName;
  }

  /** Container commands exec into. Resolved from the template at start(). */
  get containerName(): string {
    if (!this._containerName) {
      throw new SandboxNotReadyError(this.id);
    }
    return this._containerName;
  }

  /** @internal Fresh KubeConfig for the current request's credential. */
  async kubeConfig(): Promise<KubeConfig> {
    return this._credentials.getKubeConfig();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start(): Promise<void> {
    const kc = await this.kubeConfig();
    const custom = kc.makeApiClient(CustomObjectsApi);

    if (this._resourceMode === 'sandboxClaim') {
      await this._ensureSandboxClaim(custom);
      await this._waitForClaimSandbox(custom);
      await this._waitForPodReady(kc);
      this._lastActivityBumpMs = Date.now();
      return;
    }

    const existing = await this._getSandbox(custom);
    if (existing) {
      this.logger.debug(`${LOG_PREFIX} Resuming existing Sandbox ${this.namespace}/${this.sandboxName}`);
      await this._patchSandbox(custom, {
        spec: { replicas: 1, shutdownTime: this._nextShutdownTime() },
      });
    } else {
      const template = await this._readTemplate(custom);
      this.logger.debug(
        `${LOG_PREFIX} Creating Sandbox ${this.namespace}/${this.sandboxName} from template ${this._templateName}`,
      );
      const body: SandboxResource = {
        apiVersion: `${SANDBOX_GROUP}/${SANDBOX_VERSION}`,
        kind: 'Sandbox',
        metadata: {
          name: this.sandboxName,
          namespace: this.namespace,
          labels: { ...this._labels, 'appmana.com/sandbox-template': this._templateName },
          annotations: this._annotations,
        },
        spec: {
          podTemplate: template.podTemplate,
          volumeClaimTemplates: template.volumeClaimTemplates,
          replicas: 1,
          shutdownTime: this._nextShutdownTime(),
          shutdownPolicy: 'Retain',
        },
      };
      await custom.createNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.namespace,
        plural: SANDBOX_PLURAL,
        body,
      });
    }

    await this._waitForPodReady(kc);
    this._lastActivityBumpMs = Date.now();
  }

  async stop(): Promise<void> {
    const kc = await this.kubeConfig();
    const custom = kc.makeApiClient(CustomObjectsApi);
    if (this._resourceMode === 'sandboxClaim') {
      const existing = await this._getSandboxClaim(custom);
      if (!existing) return;
      this.logger.debug(`${LOG_PREFIX} Suspending SandboxClaim ${this.namespace}/${this.sandboxName}`);
      await this._patchSandboxClaim(custom, {
        spec: { lifecycle: { shutdownTime: new Date().toISOString(), shutdownPolicy: 'Retain' } },
      });
      this.processes.reset();
      return;
    }

    const existing = await this._getSandbox(custom);
    if (!existing) return;
    this.logger.debug(`${LOG_PREFIX} Suspending Sandbox ${this.namespace}/${this.sandboxName}`);
    await this._patchSandbox(custom, { spec: { replicas: 0 } });
    this.processes.reset();
  }

  async destroy(): Promise<void> {
    const kc = await this.kubeConfig();
    const custom = kc.makeApiClient(CustomObjectsApi);
    if (this._resourceMode === 'sandboxClaim') {
      this.logger.debug(`${LOG_PREFIX} Deleting SandboxClaim ${this.namespace}/${this.sandboxName}`);
      try {
        await custom.deleteNamespacedCustomObject({
          group: CLAIM_GROUP,
          version: CLAIM_VERSION,
          namespace: this.namespace,
          plural: CLAIM_PLURAL,
          name: this.sandboxName,
        });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      this.processes.reset();
      return;
    }

    this.logger.debug(`${LOG_PREFIX} Deleting Sandbox ${this.namespace}/${this.sandboxName}`);
    try {
      await custom.deleteNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.namespace,
        plural: SANDBOX_PLURAL,
        name: this.sandboxName,
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    this.processes.reset();
  }

  /**
   * Slide `shutdownTime` forward. Called by the process manager on each
   * command; debounced so steady activity patches at most once per quarter
   * of the idle window.
   * @internal
   */
  async bumpActivity(): Promise<void> {
    const now = Date.now();
    if (now - this._lastActivityBumpMs < (this._idleTimeoutS * 1000) / 4) return;
    this._lastActivityBumpMs = now;
    try {
      const kc = await this.kubeConfig();
      const custom = kc.makeApiClient(CustomObjectsApi);
      if (this._resourceMode === 'sandboxClaim') {
        await this._patchSandboxClaim(custom, {
          spec: { lifecycle: { shutdownTime: this._nextShutdownTime(), shutdownPolicy: 'Retain' } },
        });
      } else {
        await this._patchSandbox(custom, { spec: { shutdownTime: this._nextShutdownTime() } });
      }
    } catch (error) {
      this.logger.warn(`${LOG_PREFIX} Failed to slide shutdownTime for ${this.sandboxName}`, { error });
    }
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  /**
   * Run a command to completion over a single exec session.
   * Overrides the base spawn-and-wait default to avoid the detached-process
   * machinery for ordinary synchronous commands.
   */
  async executeCommand(command: string, args: string[] = [], options: ExecuteCommandOptions = {}): Promise<CommandResult> {
    await this.ensureRunning();
    await this.bumpActivity();

    const quotedArgs = args.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
    const script = quotedArgs ? `${command} ${quotedArgs}` : command;

    const started = Date.now();
    const result = await this.processes.runScript(script, {
      cwd: options.cwd,
      env: options.env as Record<string, string | undefined> | undefined,
      timeout: options.timeout,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      executionTimeMs: Date.now() - started,
      command,
      args,
    };
  }

  // ---------------------------------------------------------------------------
  // Instructions / Info
  // ---------------------------------------------------------------------------

  getInstructions(opts?: { requestContext?: RequestContext }): string {
    const defaultInstructions = [
      `You are working inside a Kubernetes pod${this._templateImage ? ` (image: ${this._templateImage})` : ''}.`,
      `The working directory is ${this.workingDir}; files under it persist across workspace restarts.`,
      'Background processes do not survive a workspace suspend.',
      'You can execute shell commands using executeCommand().',
      'You can spawn background processes using processes.spawn().',
      'In-cluster Kubernetes actions use the pod ServiceAccount (kubectl is preinstalled in the default images).',
    ].join('\n');

    if (this._instructionsOverride === undefined) return defaultInstructions;
    if (typeof this._instructionsOverride === 'string') return this._instructionsOverride;
    return this._instructionsOverride({ defaultInstructions, requestContext: opts?.requestContext });
  }

  async getInfo(): Promise<SandboxInfo> {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: new Date(),
      metadata: {
        namespace: this.namespace,
        sandboxClaim: this._resourceMode === 'sandboxClaim' ? this.sandboxName : undefined,
        sandbox: this.runtimeSandboxName,
        template: this._templateName,
        workingDir: this.workingDir,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _generateId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private _nextShutdownTime(): string {
    return new Date(Date.now() + this._idleTimeoutS * 1000).toISOString();
  }

  private async _getSandbox(custom: CustomObjectsApi): Promise<SandboxResource | null> {
    try {
      return (await custom.getNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.namespace,
        plural: SANDBOX_PLURAL,
        name: this.sandboxName,
      })) as unknown as SandboxResource;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async _getSandboxClaim(custom: CustomObjectsApi): Promise<SandboxClaimResource | null> {
    try {
      return (await custom.getNamespacedCustomObject({
        group: CLAIM_GROUP,
        version: CLAIM_VERSION,
        namespace: this.namespace,
        plural: CLAIM_PLURAL,
        name: this.sandboxName,
      })) as unknown as SandboxClaimResource;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async _ensureSandboxClaim(custom: CustomObjectsApi): Promise<void> {
    const body: SandboxClaimResource = {
      apiVersion: `${CLAIM_GROUP}/${CLAIM_VERSION}`,
      kind: 'SandboxClaim',
      metadata: {
        name: this.sandboxName,
        namespace: this.namespace,
        labels: { ...this._labels, 'appmana.com/sandbox-template': this._templateName },
        annotations: this._annotations,
      },
      spec: {
        sandboxTemplateRef: { name: this._templateName },
        additionalPodMetadata: {
          labels: this._labels,
          annotations: this._annotations,
        },
        lifecycle: {
          shutdownTime: this._nextShutdownTime(),
          shutdownPolicy: 'Retain',
        },
        ...(this._warmpool ? { warmpool: this._warmpool } : {}),
      },
    };

    const existing = await this._getSandboxClaim(custom);
    if (existing) {
      this.logger.debug(`${LOG_PREFIX} Refreshing SandboxClaim ${this.namespace}/${this.sandboxName}`);
      await this._patchSandboxClaim(custom, {
        metadata: {
          labels: body.metadata.labels,
          annotations: body.metadata.annotations,
        },
        spec: body.spec,
      });
      return;
    }

    this.logger.debug(
      `${LOG_PREFIX} Creating SandboxClaim ${this.namespace}/${this.sandboxName} for template ${this._templateName}`,
    );
    await custom.createNamespacedCustomObject({
      group: CLAIM_GROUP,
      version: CLAIM_VERSION,
      namespace: this.namespace,
      plural: CLAIM_PLURAL,
      body,
    });
  }

  private async _patchSandboxClaim(custom: CustomObjectsApi, patch: Record<string, unknown>): Promise<void> {
    await custom.patchNamespacedCustomObject(
      {
        group: CLAIM_GROUP,
        version: CLAIM_VERSION,
        namespace: this.namespace,
        plural: CLAIM_PLURAL,
        name: this.sandboxName,
        body: patch,
      },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    );
  }

  private async _waitForClaimSandbox(custom: CustomObjectsApi): Promise<void> {
    const deadline = Date.now() + this._readyTimeoutMs;
    let lastReason = 'claim has no sandbox status yet';

    while (Date.now() < deadline) {
      const claim = await this._getSandboxClaim(custom);
      const sandboxName = claim?.status?.sandbox?.name;
      if (sandboxName) {
        this._sandboxName = sandboxName;
        return;
      }

      const ready = claim?.status?.conditions?.find(c => c.type === 'Ready');
      if (ready) {
        lastReason = `Ready=${ready.status} ${ready.reason ?? ''} ${ready.message ?? ''}`.trim();
      }
      await sleep(2000);
    }

    throw new SandboxError(
      `${LOG_PREFIX} SandboxClaim ${this.namespace}/${this.sandboxName} did not report a Sandbox within ${this._readyTimeoutMs}ms (${lastReason}).`,
      'NOT_READY',
      { claim: this.sandboxName, namespace: this.namespace },
    );
  }

  private async _patchSandbox(custom: CustomObjectsApi, patch: Record<string, unknown>): Promise<void> {
    // merge-patch: we only ever set scalar spec fields
    await custom.patchNamespacedCustomObject(
      {
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: this.namespace,
        plural: SANDBOX_PLURAL,
        name: this.sandboxName,
        body: patch,
      },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch),
    );
  }

  private async _readTemplate(custom: CustomObjectsApi): Promise<SandboxTemplateSpec> {
    let template: { spec?: SandboxTemplateSpec };
    try {
      template = (await custom.getNamespacedCustomObject({
        group: TEMPLATE_GROUP,
        version: TEMPLATE_VERSION,
        namespace: this.namespace,
        plural: TEMPLATE_PLURAL,
        name: this._templateName,
      })) as { spec?: SandboxTemplateSpec };
    } catch (error) {
      if (isNotFound(error)) {
        throw new SandboxError(
          `${LOG_PREFIX} SandboxTemplate '${this._templateName}' not found in namespace '${this.namespace}'.`,
          'NOT_READY',
          { template: this._templateName, namespace: this.namespace },
        );
      }
      throw error;
    }

    const spec = template.spec;
    const podSpec = spec?.podTemplate?.spec;
    if (!spec || !podSpec) {
      throw new SandboxError(
        `${LOG_PREFIX} SandboxTemplate '${this._templateName}' has no podTemplate.`,
        'INVALID',
        { template: this._templateName },
      );
    }
    if (!podSpec.serviceAccountName) {
      throw new SandboxError(
        `${LOG_PREFIX} SandboxTemplate '${this._templateName}' does not pin a serviceAccountName; refusing to stamp it. The runtime-plane ServiceAccount must be set by the platform template.`,
        'INVALID',
        { template: this._templateName },
      );
    }

    const firstContainer = podSpec.containers?.[0];
    if (!firstContainer) {
      throw new SandboxError(`${LOG_PREFIX} SandboxTemplate '${this._templateName}' has no containers.`, 'INVALID', {
        template: this._templateName,
      });
    }
    this._containerName = this._containerName ?? firstContainer.name;
    this._templateImage = firstContainer.image;

    return { podTemplate: spec.podTemplate, volumeClaimTemplates: spec.volumeClaimTemplates };
  }

  private async _waitForPodReady(kc: KubeConfig): Promise<void> {
    const core = kc.makeApiClient(CoreV1Api);
    const deadline = Date.now() + this._readyTimeoutMs;
    let lastReason = 'pod not found yet';

    while (Date.now() < deadline) {
      let pod: V1Pod | null = null;
      try {
        pod = await core.readNamespacedPod({ name: this.podName, namespace: this.namespace });
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }

      if (pod) {
        if (pod.metadata?.deletionTimestamp) {
          // A terminating pod can still report Ready while its volumes are
          // being torn down (suspend/resume race) — wait for its replacement.
          lastReason = 'previous pod still terminating';
        } else {
          const ready = pod.status?.conditions?.find(c => c.type === 'Ready');
          if (ready?.status === 'True') {
            if (!this._containerName) {
              this._containerName = pod.spec?.containers?.[0]?.name;
              this._templateImage = pod.spec?.containers?.[0]?.image;
            }
            return;
          }
          lastReason = `phase=${pod.status?.phase ?? 'Unknown'} ready=${ready?.status ?? 'Unknown'}`;
        }
      }

      await sleep(2000);
    }

    throw new SandboxError(
      `${LOG_PREFIX} Pod ${this.namespace}/${this.podName} did not become Ready within ${this._readyTimeoutMs}ms (${lastReason}).`,
      'NOT_READY',
      { pod: this.podName, namespace: this.namespace },
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isNotFound(error: unknown): boolean {
  const e = error as { code?: number; statusCode?: number; response?: { statusCode?: number }; body?: unknown };
  const status = e?.code ?? e?.statusCode ?? e?.response?.statusCode;
  if (status === 404) return true;
  if (error instanceof Error && /not\s*found/i.test(error.message)) return true;
  return false;
}
