/**
 * Kubernetes sandbox provider descriptor for MastraEditor.
 *
 * @example
 * ```typescript
 * import { kubernetesSandboxProvider } from '@appmana-public/mastra-provider-kubernetes';
 *
 * const editor = new MastraEditor({
 *   sandboxes: [kubernetesSandboxProvider],
 * });
 * ```
 */
import type { SandboxProvider } from '@mastra/core/editor';
import type { KubernetesAuthOptions } from './sandbox/auth';
import { KubernetesSandbox } from './sandbox/index';

/**
 * Serializable subset of KubernetesSandboxOptions for editor storage.
 * The auth block is environment-driven by default: stored workspaces carry
 * the namespace/template selection while credentials come from the runtime.
 */
export interface KubernetesProviderConfig {
  namespace: string;
  sandboxTemplateName: string;
  idleTimeoutSeconds?: number;
  workingDir?: string;
  timeout?: number;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  auth?: KubernetesAuthOptions;
}

function authFromEnvironment(): KubernetesAuthOptions {
  const tokenUrl = process.env.MASTRA_K8S_OIDC_TOKEN_URL;
  if (!tokenUrl) {
    return { strategy: 'static' };
  }
  return {
    strategy: 'tokenExchange',
    tokenUrl,
    clientId: process.env.MASTRA_K8S_OIDC_CLIENT_ID ?? '',
    clientSecret: process.env.MASTRA_K8S_OIDC_CLIENT_SECRET,
    audience: process.env.MASTRA_K8S_OIDC_AUDIENCE ?? '',
    subjectToken: () => {
      throw new Error(
        'kubernetesSandboxProvider: a per-request subjectToken supplier is required for tokenExchange. ' +
          'Construct KubernetesSandbox from a workspace DynamicArgument with the request bearer token instead.',
      );
    },
  };
}

export const kubernetesSandboxProvider: SandboxProvider<KubernetesProviderConfig> = {
  id: 'kubernetes',
  name: 'Kubernetes Sandbox',
  description: 'Workspace pod + persistent volume in a tenant namespace, backed by kubernetes-sigs/agent-sandbox',
  configSchema: {
    type: 'object',
    required: ['namespace', 'sandboxTemplateName'],
    properties: {
      namespace: {
        type: 'string',
        description: 'Tenant namespace the sandbox lives in (e.g. user-<oidc sub>)',
      },
      sandboxTemplateName: {
        type: 'string',
        description: 'Platform-owned SandboxTemplate to stamp the sandbox from',
      },
      idleTimeoutSeconds: {
        type: 'number',
        description: 'Sliding idle window; on expiry the sandbox suspends and its volume persists',
        default: 3600,
      },
      workingDir: { type: 'string', description: 'Working directory', default: '/workspace' },
      timeout: { type: 'number', description: 'Default command timeout in milliseconds', default: 300000 },
      env: {
        type: 'object',
        description: 'Environment variables for commands',
        additionalProperties: { type: 'string' },
      },
      labels: {
        type: 'object',
        description: 'Extra labels for the Sandbox object',
        additionalProperties: { type: 'string' },
      },
      annotations: {
        type: 'object',
        description: 'Extra annotations for the Sandbox object',
        additionalProperties: { type: 'string' },
      },
    },
  },
  createSandbox: config =>
    new KubernetesSandbox({
      ...config,
      auth: config.auth ?? authFromEnvironment(),
    }),
};
