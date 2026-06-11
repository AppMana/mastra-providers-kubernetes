/**
 * Credential strategies for talking to the kube-apiserver.
 *
 * Zero-trust rule: every apiserver call made on behalf of a user is
 * authenticated with a credential derived from that user's OIDC token via
 * OAuth2 token exchange (RFC 8693). The provider never holds standing
 * cluster credentials; RBAC and audit are enforced per user by the
 * apiserver. The `static` strategy exists for local development and
 * integration tests only.
 */

import { readFileSync } from 'node:fs';
import { KubeConfig } from '@kubernetes/client-node';

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** Refresh exchanged tokens this many ms before they actually expire. */
const EXPIRY_SLACK_MS = 30_000;

export interface TokenExchangeAuthOptions {
  strategy: 'tokenExchange';
  /** OIDC token endpoint, e.g. https://login.example.com/realms/x/protocol/openid-connect/token */
  tokenUrl: string;
  /** The client performing the exchange (the app's own OIDC client). */
  clientId: string;
  clientSecret?: string;
  /** Audience the apiserver expects (its --oidc-client-id / authenticator audience). */
  audience: string;
  /**
   * OAuth scopes to request on the exchange. When the audience mapper lives
   * on an optional client scope (so ordinary logins never carry the apiserver
   * audience), that scope must be requested here, e.g. 'openid kubernetes-api'.
   */
  scope?: string;
  /** Supplier of the end user's raw bearer token for the current request. */
  subjectToken: () => string | Promise<string>;
  /**
   * Kube-apiserver connection. Defaults to in-cluster discovery
   * (KUBERNETES_SERVICE_HOST + mounted CA).
   */
  server?: string;
  caFile?: string;
  caData?: string;
  skipTLSVerify?: boolean;
}

export interface StaticAuthOptions {
  strategy: 'static';
  /** Path to a kubeconfig file; defaults to standard loading rules. */
  kubeconfigPath?: string;
  /** Kubeconfig context to use. */
  context?: string;
}

export type KubernetesAuthOptions = TokenExchangeAuthOptions | StaticAuthOptions;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export interface CredentialProvider {
  /** Build a KubeConfig authenticated for the current request. */
  getKubeConfig(): Promise<KubeConfig>;
}

interface TokenExchangeResponse {
  access_token: string;
  expires_in?: number;
  issued_token_type?: string;
  token_type?: string;
}

const IN_CLUSTER_CA = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

function discoverServer(options: TokenExchangeAuthOptions): { server: string; caData?: string; caFile?: string } {
  if (options.server) {
    return { server: options.server, caData: options.caData, caFile: options.caFile };
  }
  const host = process.env.KUBERNETES_SERVICE_HOST;
  const port = process.env.KUBERNETES_SERVICE_PORT ?? '443';
  if (!host) {
    throw new Error(
      'KubernetesSandbox: no apiserver configured. Set auth.server or run in-cluster (KUBERNETES_SERVICE_HOST).',
    );
  }
  return { server: `https://${host}:${port}`, caFile: IN_CLUSTER_CA };
}

export class TokenExchangeCredentialProvider implements CredentialProvider {
  private readonly options: TokenExchangeAuthOptions;
  /** Exchanged tokens keyed by the subject token they were derived from. */
  private readonly cache = new Map<string, CachedToken>();

  constructor(options: TokenExchangeAuthOptions) {
    this.options = options;
  }

  async getKubeConfig(): Promise<KubeConfig> {
    const subject = await this.options.subjectToken();
    if (!subject) {
      throw new Error('KubernetesSandbox: no subject token available for token exchange.');
    }
    const exchanged = await this.exchange(subject);
    return this.buildKubeConfig(exchanged);
  }

  private async exchange(subjectToken: string): Promise<string> {
    const cached = this.cache.get(subjectToken);
    if (cached && cached.expiresAtMs > Date.now() + EXPIRY_SLACK_MS) {
      return cached.accessToken;
    }

    const body = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      audience: this.options.audience,
      client_id: this.options.clientId,
    });
    if (this.options.clientSecret) {
      body.set('client_secret', this.options.clientSecret);
    }
    if (this.options.scope) {
      body.set('scope', this.options.scope);
    }

    const response = await fetch(this.options.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `KubernetesSandbox: token exchange failed (${response.status} ${response.statusText}): ${text.slice(0, 500)}`,
      );
    }

    const json = (await response.json()) as TokenExchangeResponse;
    if (!json.access_token) {
      throw new Error('KubernetesSandbox: token exchange response did not contain an access_token.');
    }

    const expiresInS = json.expires_in ?? 60;
    this.cache.set(subjectToken, {
      accessToken: json.access_token,
      expiresAtMs: Date.now() + expiresInS * 1000,
    });

    // Drop expired entries so the cache does not grow with every login.
    for (const [key, value] of this.cache) {
      if (value.expiresAtMs <= Date.now()) this.cache.delete(key);
    }

    return json.access_token;
  }

  private buildKubeConfig(token: string): KubeConfig {
    const { server, caData, caFile } = discoverServer(this.options);
    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [
        {
          name: 'cluster',
          server,
          caData: caData ?? (caFile ? readFileSync(caFile).toString('base64') : undefined),
          skipTLSVerify: this.options.skipTLSVerify ?? false,
        },
      ],
      users: [{ name: 'user', token }],
      contexts: [{ name: 'ctx', cluster: 'cluster', user: 'user' }],
      currentContext: 'ctx',
    });
    return kc;
  }
}

export class StaticCredentialProvider implements CredentialProvider {
  private readonly kubeConfig: KubeConfig;

  constructor(options: StaticAuthOptions) {
    const kc = new KubeConfig();
    if (options.kubeconfigPath) {
      kc.loadFromFile(options.kubeconfigPath);
    } else {
      kc.loadFromDefault();
    }
    if (options.context) {
      kc.setCurrentContext(options.context);
    }
    this.kubeConfig = kc;
  }

  async getKubeConfig(): Promise<KubeConfig> {
    return this.kubeConfig;
  }
}

export function createCredentialProvider(options: KubernetesAuthOptions): CredentialProvider {
  switch (options.strategy) {
    case 'tokenExchange':
      return new TokenExchangeCredentialProvider(options);
    case 'static':
      return new StaticCredentialProvider(options);
    default: {
      const strategy = (options as { strategy?: string }).strategy;
      throw new Error(`KubernetesSandbox: unknown auth strategy '${strategy}'.`);
    }
  }
}
