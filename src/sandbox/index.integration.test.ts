/**
 * Integration test against a real cluster with kubernetes-sigs/agent-sandbox
 * installed (extensions enabled).
 *
 * Gated: set K8S_INTEGRATION=1 and point KUBECONFIG at a cluster where the
 * current credential can create namespaces (the test provisions its own
 * namespace, ServiceAccount, and SandboxTemplate, and removes them after).
 *
 *   K8S_INTEGRATION=1 KUBECONFIG=~/.kube/config pnpm test:integration
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreV1Api, CustomObjectsApi, KubeConfig } from '@kubernetes/client-node';
import { PodFilesystem } from './filesystem';
import { KubernetesSandbox, SANDBOX_GROUP, SANDBOX_VERSION, SANDBOX_PLURAL, isNotFound } from './index';

const enabled = process.env.K8S_INTEGRATION === '1';
const d = describe.skipIf(!enabled);

const NAMESPACE = `mastra-k8s-it-${Date.now().toString(36)}`;
const TEMPLATE = 'workspace-it';
const IMAGE = process.env.K8S_INTEGRATION_IMAGE ?? 'ubuntu:24.04';
const STORAGE_CLASS = process.env.K8S_INTEGRATION_STORAGE_CLASS ?? 'longhorn';
const NODE_SELECTOR = process.env.K8S_INTEGRATION_NODE_SELECTOR
  ? (JSON.parse(process.env.K8S_INTEGRATION_NODE_SELECTOR) as Record<string, string>)
  : undefined;
const CONTEXT = process.env.K8S_INTEGRATION_CONTEXT;

function adminKubeConfig(): KubeConfig {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  if (CONTEXT) kc.setCurrentContext(CONTEXT);
  return kc;
}

d('KubernetesSandbox integration', () => {
  const kc = adminKubeConfig();
  const core = kc.makeApiClient(CoreV1Api);
  const custom = kc.makeApiClient(CustomObjectsApi);
  let sandbox: KubernetesSandbox;

  beforeAll(async () => {
    await core.createNamespace({ body: { metadata: { name: NAMESPACE } } });
    await core.createNamespacedServiceAccount({ namespace: NAMESPACE, body: { metadata: { name: 'workspace' } } });
    await custom.createNamespacedCustomObject({
      group: 'extensions.agents.x-k8s.io',
      version: 'v1alpha1',
      namespace: NAMESPACE,
      plural: 'sandboxtemplates',
      body: {
        apiVersion: 'extensions.agents.x-k8s.io/v1alpha1',
        kind: 'SandboxTemplate',
        metadata: { name: TEMPLATE, namespace: NAMESPACE },
        spec: {
          podTemplate: {
            spec: {
              serviceAccountName: 'workspace',
              nodeSelector: NODE_SELECTOR,
              containers: [
                {
                  name: 'workspace',
                  image: IMAGE,
                  command: ['sleep', 'infinity'],
                  workingDir: '/workspace',
                  volumeMounts: [{ name: 'data', mountPath: '/workspace' }],
                },
              ],
            },
          },
          volumeClaimTemplates: [
            {
              metadata: { name: 'data' },
              spec: {
                accessModes: ['ReadWriteOnce'],
                storageClassName: STORAGE_CLASS,
                resources: { requests: { storage: '1Gi' } },
              },
            },
          ],
        },
      },
    });

    sandbox = new KubernetesSandbox({
      id: 'it',
      namespace: NAMESPACE,
      sandboxTemplateName: TEMPLATE,
      auth: { strategy: 'static', context: CONTEXT },
      namespacePattern: /^mastra-k8s-it-[a-z0-9]+$/,
      idleTimeoutSeconds: 1800,
      readyTimeoutMs: 600_000,
      timeout: 120_000,
    });
  }, 120_000);

  afterAll(async () => {
    try {
      await custom.deleteNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: NAMESPACE,
        plural: SANDBOX_PLURAL,
        name: 'ws-it',
      });
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await core.deleteNamespace({ name: NAMESPACE });
  }, 120_000);

  it('starts a sandbox from the template', async () => {
    await sandbox._start();
    const result = await sandbox.executeCommand('echo', ['hello from $(hostname)']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello from');
  }, 600_000);

  it('executes commands with working directory and env', async () => {
    const result = await sandbox.executeCommand('pwd && printf %s "$WS_TEST"', [], {
      env: { WS_TEST: 'env-ok' } as NodeJS.ProcessEnv,
    });
    expect(result.stdout).toContain('/workspace');
    expect(result.stdout).toContain('env-ok');
  }, 60_000);

  it('reports non-zero exit codes', async () => {
    const result = await sandbox.executeCommand('exit 3');
    expect(result.exitCode).toBe(3);
    expect(result.success).toBe(false);
  }, 60_000);

  it('reads and writes files through PodFilesystem', async () => {
    const fs = new PodFilesystem(sandbox);
    await fs.writeFile('uploads/hello.txt', 'workspace-file-content');
    const read = await fs.readFile('uploads/hello.txt', { encoding: 'utf8' });
    expect(read).toBe('workspace-file-content');

    const binary = Buffer.from([0, 1, 2, 250, 255]);
    await fs.writeFile('uploads/blob.bin', binary);
    const roundTrip = (await fs.readFile('uploads/blob.bin')) as Buffer;
    expect(Buffer.compare(roundTrip, binary)).toBe(0);

    const entries = await fs.readdir('uploads');
    expect(entries.map(e => e.name).sort()).toEqual(['blob.bin', 'hello.txt']);

    const stat = await fs.stat('uploads/hello.txt');
    expect(stat.type).toBe('file');
    expect(stat.size).toBe('workspace-file-content'.length);
  }, 120_000);

  it('spawns detached processes and waits for their exit', async () => {
    const handle = await sandbox.processes.spawn('for i in 1 2 3; do echo "tick $i"; sleep 0.2; done');
    const result = await handle.wait();
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tick 1');
    expect(result.stdout).toContain('tick 3');
  }, 120_000);

  it('kills runaway processes', async () => {
    const handle = await sandbox.processes.spawn('sleep 600');
    const killed = await handle.kill();
    expect(killed).toBe(true);
    const result = await handle.wait();
    expect(result.exitCode).not.toBe(0);
  }, 120_000);

  it('suspends and resumes with files intact', async () => {
    const fs = new PodFilesystem(sandbox);
    await fs.writeFile('persist.txt', 'still-here');

    await sandbox._stop();
    await sandbox._start();

    const read = await fs.readFile('persist.txt', { encoding: 'utf8' });
    expect(read).toBe('still-here');
  }, 600_000);

  it('destroys the sandbox and its volume', async () => {
    await sandbox._destroy();
    let exists = true;
    try {
      await custom.getNamespacedCustomObject({
        group: SANDBOX_GROUP,
        version: SANDBOX_VERSION,
        namespace: NAMESPACE,
        plural: SANDBOX_PLURAL,
        name: 'ws-it',
      });
    } catch (error) {
      if (isNotFound(error)) exists = false;
      else throw error;
    }
    expect(exists).toBe(false);
  }, 120_000);
});
