import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenExchangeCredentialProvider } from './auth';

const TOKEN_URL = 'https://idp.example.com/realms/x/protocol/openid-connect/token';

function makeProvider(subjectToken = 'subject-token') {
  return new TokenExchangeCredentialProvider({
    strategy: 'tokenExchange',
    tokenUrl: TOKEN_URL,
    clientId: 'app',
    clientSecret: 'secret',
    audience: 'serverclient',
    scope: 'openid kubernetes-api',
    subjectToken: () => subjectToken,
    server: 'https://kubernetes.example.com:6443',
    skipTLSVerify: true,
  });
}

describe('TokenExchangeCredentialProvider', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: 'exchanged-token', expires_in: 300 }), { status: 200 }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('performs an RFC 8693 exchange with the configured audience', async () => {
    const provider = makeProvider();
    const kc = await provider.getKubeConfig();

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(TOKEN_URL);
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('subject_token')).toBe('subject-token');
    expect(body.get('audience')).toBe('serverclient');
    expect(body.get('client_id')).toBe('app');
    expect(body.get('client_secret')).toBe('secret');
    expect(body.get('scope')).toBe('openid kubernetes-api');

    expect(kc.getCurrentUser()?.token).toBe('exchanged-token');
    expect(kc.getCurrentCluster()?.server).toBe('https://kubernetes.example.com:6443');
  });

  it('caches the exchanged token per subject token until expiry', async () => {
    const provider = makeProvider();
    await provider.getKubeConfig();
    await provider.getKubeConfig();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('re-exchanges for a different subject token', async () => {
    let subject = 'user-a';
    const provider = new TokenExchangeCredentialProvider({
      strategy: 'tokenExchange',
      tokenUrl: TOKEN_URL,
      clientId: 'app',
      audience: 'serverclient',
      subjectToken: () => subject,
      server: 'https://kubernetes.example.com:6443',
    });
    await provider.getKubeConfig();
    subject = 'user-b';
    await provider.getKubeConfig();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('throws a descriptive error on a failed exchange', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('access_denied', { status: 403, statusText: 'Forbidden' })),
    );
    const provider = makeProvider();
    await expect(provider.getKubeConfig()).rejects.toThrow(/token exchange failed \(403/);
  });

  it('throws when no subject token is available', async () => {
    const provider = makeProvider('');
    await expect(provider.getKubeConfig()).rejects.toThrow(/no subject token/);
  });
});
