# @appmana-public/mastra-provider-kubernetes

A [Mastra](https://mastra.ai) workspace sandbox provider that runs coding/terminal
workspaces as ordinary Kubernetes objects, backed by
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox).

Each Mastra workspace maps to one `Sandbox` (a singleton stateful pod) plus
`PersistentVolumeClaim`s in a tenant namespace. Quotas, cleanup, GPU resource
requests, network policy, and persistence are all handled by ordinary,
decoupled Kubernetes features — this package is a thin client, not a controller.

## How it works

- **Templates are platform-owned.** A `SandboxTemplate` in the tenant namespace
  pins the image, resources, `serviceAccountName`, and (managed) NetworkPolicy.
  The provider refuses templates without a `serviceAccountName`.
- **Instances are `Sandbox` objects** stamped from the template. Suspend deletes
  the pod and keeps the PVCs; resume recreates the pod. The provider slides
  `shutdownTime` forward on activity, so idle workspaces suspend without any
  custom controller.
- **Zero trust.** Every API call is made with a credential derived from the end
  user's OIDC token via OAuth2 token exchange (RFC 8693). The provider holds no
  standing cluster credentials; RBAC and audit are enforced per user by the
  kube-apiserver. Inside the pod, in-cluster actions use the template's
  ServiceAccount projected token — user tokens are never forwarded into pods.
- **Exec/files** go over the Kubernetes exec websocket (`pods/exec`).

## Usage

```typescript
import { MastraEditor } from "@mastra/core/editor";
import { kubernetesSandboxProvider } from "@appmana-public/mastra-provider-kubernetes";

const editor = new MastraEditor({
  sandboxes: [kubernetesSandboxProvider],
});
```

Per-request, per-user binding:

```typescript
import { Workspace } from "@mastra/core/workspace";
import { KubernetesSandbox } from "@appmana-public/mastra-provider-kubernetes";

const agent = new Agent({
  // ...
  workspace: async ({ requestContext }) => {
    const user = requestContext.get("user");
    return new Workspace({
      sandbox: new KubernetesSandbox({
        namespace: `user-${user.sub}`,
        sandboxTemplateName: "workspace-base",
        auth: {
          strategy: "tokenExchange",
          tokenUrl: process.env.OIDC_TOKEN_URL!,
          clientId: process.env.OIDC_CLIENT_ID!,
          clientSecret: process.env.OIDC_CLIENT_SECRET!,
          audience: process.env.KUBERNETES_OIDC_AUDIENCE!,
          subjectToken: () => requestContext.get("rawBearerToken"),
        },
      }),
    });
  },
});
```

## Cluster prerequisites

1. [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) installed
   with extensions (`SandboxTemplate`) enabled.
2. The kube-apiserver trusts your OIDC issuer (either directly or via an
   additional JWT authenticator in a structured `AuthenticationConfiguration`),
   and your IdP permits RFC 8693 token exchange from the app's client to the
   apiserver audience.
3. Per-tenant RBAC granting users `sandboxes.agents.x-k8s.io` CRUD,
   `sandboxtemplates` read, `pods` read, and `pods/exec` in their namespace.

## Workspace images

`images/` contains the default workspace images, published to
`ghcr.io/appmana/workspace-base` and `ghcr.io/appmana/workspace-cuda`.

## License

Apache-2.0
