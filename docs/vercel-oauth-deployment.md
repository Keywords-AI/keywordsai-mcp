# Public MCP OAuth Broker: Vercel Deployment Runbook

This runbook covers the first Preview and Production deployments of the
MCP-owned OAuth session broker in the Vercel project `respan-ai/keywordsai-mcp`.
It is intentionally specific to this repository and the current Vercel project.

The broker must not be deployed until its Redis store, environment isolation,
public URLs, and Preview access path are ready. A successful build by itself is
not a successful OAuth deployment.

## Deployment ownership

The deployment needs the following people or permissions:

- A Vercel Respan team Owner or Member who can install a Marketplace product,
  create a database, and approve any billing plan.
- A project operator who can manage Preview environment variables and domains.
- The `Environment Manager`, `Environment Variable Manager`, and
  `Deployment Protection Manager` permissions if the operator is a Vercel
  Developer rather than a Member.
- GitHub permission to push the feature branch and later merge its pull request
  into `main`.

On the Respan Pro team, temporarily granting the operator the Vercel `Member`
role is the simplest setup path. If that is too broad, an Owner or Member can
perform the Upstash installation while the operator receives only the three
permission groups listed above.

Never send `OAUTH_SECRET`, Redis tokens, backend JWTs, or API keys through Slack,
email, an issue, a pull request, or deployment logs.

## Known Vercel project configuration

| Setting | Current value or behavior |
| --- | --- |
| Team | `Respan` |
| Project | `keywordsai-mcp` |
| Git repository | `respanai/respan-mcp` |
| Production branch | `main` |
| Primary Production domain | `https://mcp.respan.ai` |
| Additional Production domain | `https://mcp.keywordsai.co` |
| Vercel project domain | `https://keywordsai-mcp.vercel.app` |
| Preview branch tracking | All branches not assigned to another environment |
| Build command | `npm ci && npm run build` |
| Output directory | `dist/client` |
| Node.js version observed in Vercel | `24.x` |
| Deployment configuration | `vercel.json` |

Pushing a non-`main` branch creates a Preview deployment. Pushing or merging to
`main` creates a Production deployment and assigns the Production domains.
There is no separate repository deployment script or GitHub Actions deployment
workflow.

## Security boundary

The deployed service must preserve all of these invariants:

- OAuth MCP clients receive only opaque `mcp_at_...` and `mcp_rt_...`
  credentials.
- Backend access and refresh JWTs remain encrypted inside broker records.
- The inbound MCP credential is never forwarded to the backend.
- Redis keys contain hashes and namespaced record identifiers, not raw tokens.
- Preview and Production use separate Redis databases, encryption secrets, and
  key prefixes.
- A real Respan API key continues through the independent API-key path and does
  not depend on Redis.
- Backend access JWTs emitted by the existing non-OAuth `/login` configuration
  remain on that same Redis-independent compatibility path. Only `mcp_`-
  prefixed credentials are reserved for the broker.
- Production access sessions last no more than 14,400 seconds.
- Refresh sessions last no longer than the backend refresh JWT, approximately
  30 days.
- Successful refresh rotates the access and refresh credentials atomically.

Do not set a shared hosted `RESPAN_API_KEY` for this public OAuth deployment.
That variable is for private shared-key deployments and is not part of the
public broker boundary.

## Vercel services

### Required

| Service | Required configuration |
| --- | --- |
| Git Integration | Keep `respanai/respan-mcp` connected. Preview branches deploy automatically and `main` is Production. |
| Vercel Functions | No manual enablement is needed. The API files and function limits are declared in `vercel.json`. |
| Upstash for Redis | Install the native Marketplace product and provision separate Preview and Production resources. |
| Environment Variables | Configure the broker variables with distinct Preview and Production values. |
| Domains | Attach a stable domain to the Preview environment; keep `mcp.respan.ai` as the Production base URL. |
| Deployment Protection | Keep Vercel Authentication for ordinary Previews, but add an exception for the dedicated OAuth Preview domain. |
| System Environment Variables | Leave enabled so Vercel supplies `VERCEL_ENV`; the broker uses it to reject non-Upstash stores on Vercel. |

### Recommended

| Service | Configuration |
| --- | --- |
| Logs | Use Vercel runtime logs during the rollout. Do not log request authorization headers, OAuth codes, token responses, or Redis values. |
| Observability | Monitor function errors, 401/429/5xx rates, latency, and invocation volume. |
| Upstash usage controls | Use a Free plan for Preview. For Production, use the approved plan with a $10 monthly budget cap and usage alerts when supported. Confirm current pricing before approval. |
| Deployment retention | Retain the last known-good Production deployment for immediate rollback. |

### Not required for this release

- Vercel Blob, Edge Config, Postgres, or the separate official Redis product.
- A new Vercel Cron Job.
- Rolling Releases.
- A deployment hook.
- A new scope or permission service.
- A new OAuth client-registration service.
- A Vercel Firewall exception, unless an existing team policy blocks the MCP
  endpoints.

## Phase 1: repository gate

Use the registered repository worktree and feature branch. Do not deploy from
`main` before Preview verification.

```bash
cd /workspaces/respan-mcp
git worktree list --porcelain
git branch --show-current
git status --short
npm test
npm run build
git diff --check
```

Expected branch:

```text
feature/mcp-oauth-session-broker
```

Before pushing, commit all intended OAuth broker and security-hardening changes
on the feature branch. Preserve unrelated changes and do not create or clean up
worktrees as part of deployment.

The local verification gate must include:

- OAuth code exchange and one-use code behavior.
- Access-token expiration.
- Successful refresh and atomic pair rotation.
- Reuse of the spent refresh token returning `invalid_grant`.
- A post-refresh MCP initialization and tool call.
- Platform and enterprise audience separation.
- A real API key completing an MCP request with zero Redis operations.
- Inspection confirming that backend credentials do not appear in browser
  storage, browser responses, MCP responses, Redis keys, or logs.

## Phase 2: provision Preview Upstash

An authorized Vercel team member should:

1. Open `https://vercel.com/marketplace/upstash/upstash-kv`.
2. Select **Add Product**.
3. Choose the **Respan** team.
4. Install **Upstash for Redis**.
5. Create a database named `keywordsai-mcp-preview`.
6. Use the Free plan for the Preview database.
7. Select an approved region close to the Vercel functions and Respan backend.
8. Connect the resource only to the `keywordsai-mcp` project.
9. Restrict the generated variables to the **Preview** environment.
10. Confirm that the resource appears under the project's Storage or
    Integrations page.

Do not reuse an unrelated Redis database and do not connect the Preview resource
to Production.

### Upstash variable-name check

The broker code requires:

```text
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
```

Some Vercel Upstash installation flows display or generate names such as:

```text
KV_REST_API_URL
KV_REST_API_TOKEN
```

After connecting the integration, inspect only the variable names. If Vercel did
not create the exact `UPSTASH_REDIS_REST_*` names, create Preview-scoped
variables using the corresponding Upstash REST URL and REST token. Do not put
the values into a local shell history or copy them into this document.

The deployment will fail closed if the exact variables expected by the broker
are absent.

## Phase 3: configure a stable Preview origin

OAuth resource, redirect, issuer, cookie, and CSRF checks use exact origins. A
per-deployment Vercel URL that changes on every push is unsuitable as the broker
base URL.

1. Open the `keywordsai-mcp` project.
2. Go to **Settings → Environments → Preview**.
3. Attach a stable domain, for example:

   ```text
   mcp-oauth-preview.respan.ai
   ```

4. Ensure the domain is assigned to the Preview environment, not Production.
5. Go to **Settings → Deployment Protection**.
6. Leave **Vercel Authentication** enabled for ordinary Preview deployments.
7. Under **Deployment Protection Exceptions**, add only:

   ```text
   mcp-oauth-preview.respan.ai
   ```

Hosted MCP clients cannot complete Vercel's team-login challenge and generally
cannot supply an automation-bypass header. The dedicated Preview domain must be
publicly reachable for the OAuth browser redirect and token exchange to work.

Remove or re-protect this dedicated domain after the Preview test window if it
will not be retained for future release verification.

## Phase 4: configure environment variables

### Required and recommended variable reference

| Variable | Required | Preview value | Production value | Notes |
| --- | --- | --- | --- | --- |
| `OAUTH_SECRET` | Yes | Unique random secret | Different unique random secret | Minimum 32 characters. Encrypts broker-held backend credentials. Never reuse across environments. |
| `OAUTH_SESSION_STORE` | Yes | `upstash` | `upstash` | Any Vercel deployment using another store is rejected. |
| `UPSTASH_REDIS_REST_URL` | Yes | Preview REST URL | Production REST URL | Must be an HTTPS Upstash REST endpoint. |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Preview REST token | Production REST token | Mark sensitive. Never expose it. |
| `MCP_PUBLIC_BASE_URL` | Yes | `https://mcp-oauth-preview.respan.ai` | `https://mcp.respan.ai` | No trailing slash. Must match the origin clients use. |
| `MCP_REDIS_KEY_PREFIX` | Recommended | `respan-mcp:preview:` | `respan-mcp:production:` | Defense in depth even though the databases are separate. |
| `MCP_ACCESS_TOKEN_TTL_SECONDS` | Yes for rollout | `60` | `14400` | Preview uses 60 seconds to prove expiry. Production uses four hours. |
| `RESPAN_API_BASE_URL` | Recommended | `https://api.respan.ai/api` | `https://api.respan.ai/api` | Platform realm backend. |
| `RESPAN_ENTERPRISE_API_BASE_URL` | Recommended | `https://endpoint.respan.ai/api` | `https://endpoint.respan.ai/api` | Enterprise realm backend. |

The following broker variables have validated defaults and normally do not need
Vercel overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_AUTHORIZATION_CODE_TTL_SECONDS` | `600` | One-use authorization-code lifetime. |
| `MCP_AUTHORIZATION_TRANSACTION_TTL_SECONDS` | `600` | Pending browser authorization lifetime. |
| `MCP_REFRESH_SESSION_TTL_SECONDS` | `2592000` | Maximum refresh-session lifetime, 30 days. |
| `MCP_REFRESH_LOCK_TTL_SECONDS` | `30` | Refresh concurrency lock lifetime. Values below 30 are rejected so the lock outlives the eight-second backend timeout. |
| `VERCEL_ENV` | Supplied by Vercel | Environment detection and production HTTPS enforcement. |
| `NODE_ENV` | Supplied by the runtime/build | Local fallback for namespacing when `VERCEL_ENV` is absent. Do not override it in Vercel. |

Leave these unset:

| Variable | Reason |
| --- | --- |
| `REDIS_URL` | Local Redis only. Vercel deployments require the Upstash store. |
| `RESPAN_API_KEY` | Would create a shared hosted credential outside the public OAuth broker boundary. |
| `OAUTH_TEST_EMAIL` | Test-process credential; never a hosted runtime variable. |
| `OAUTH_TEST_PASSWORD` | Test-process credential; never a hosted runtime variable. |
| `OAUTH_TEST_API_KEY` | Test-process credential; never a hosted runtime variable. |

Preserve `RESPAN_DOCS_API_KEY` if the existing `/mcp/docs` and `/docs/chat`
features still require it. It is independent of the public OAuth broker.

### Generate secrets

Generate Preview and Production secrets separately. Run the command in an
approved secure environment and paste each result directly into the matching
Vercel sensitive-variable field:

```bash
openssl rand -base64 48
```

Do not store the output in the repository, `.env.example`, a shell script, or
the deployment runbook.

### Split the existing all-environments secret

The Vercel project currently has an `OAUTH_SECRET` targeting all environments.
Do not allow that single secret to remain shared between Preview and Production.

1. Preserve the current Production value until the Production cutover decision.
2. Restrict the existing variable so that it no longer supplies Preview.
3. Create a new Preview-only `OAUTH_SECRET`.
4. Before Production deployment, create or confirm a separate
   Production-only `OAUTH_SECRET`.
5. Mark both as sensitive.

Changing `OAUTH_SECRET` invalidates the ability to decrypt records created with
the old secret. This is acceptable for a deliberate cutover but requires users
to authenticate again.

### Preview variable set

Create these variables with the **Preview** target only:

```dotenv
OAUTH_SECRET=<preview-only-random-secret>
OAUTH_SESSION_STORE=upstash
UPSTASH_REDIS_REST_URL=<preview-upstash-rest-url>
UPSTASH_REDIS_REST_TOKEN=<preview-upstash-rest-token>
MCP_PUBLIC_BASE_URL=https://mcp-oauth-preview.respan.ai
MCP_REDIS_KEY_PREFIX=respan-mcp:preview:
MCP_ACCESS_TOKEN_TTL_SECONDS=60
RESPAN_API_BASE_URL=https://api.respan.ai/api
RESPAN_ENTERPRISE_API_BASE_URL=https://endpoint.respan.ai/api
```

### Production variable set

Prepare these with the **Production** target only. Do not deploy them until the
Preview gate passes:

```dotenv
OAUTH_SECRET=<production-only-random-secret>
OAUTH_SESSION_STORE=upstash
UPSTASH_REDIS_REST_URL=<production-upstash-rest-url>
UPSTASH_REDIS_REST_TOKEN=<production-upstash-rest-token>
MCP_PUBLIC_BASE_URL=https://mcp.respan.ai
MCP_REDIS_KEY_PREFIX=respan-mcp:production:
MCP_ACCESS_TOKEN_TTL_SECONDS=14400
RESPAN_API_BASE_URL=https://api.respan.ai/api
RESPAN_ENTERPRISE_API_BASE_URL=https://endpoint.respan.ai/api
```

Review the Vercel target badges after saving every variable. A correct value
with the wrong target is a deployment defect.

## Phase 5: deploy Preview

1. Confirm the repository gate is green.
2. Commit the intended changes on `feature/mcp-oauth-session-broker`.
3. Push that feature branch to GitHub.
4. Open the Vercel `keywordsai-mcp` Deployments page.
5. Confirm Vercel creates a Preview deployment for the feature branch.
6. Inspect the build details and verify:
   - the build used the intended commit SHA;
   - `npm ci && npm run build` succeeded;
   - the source `vercel.json` configuration was applied;
   - the deployment used the Preview environment variables;
   - no secret value appeared in the build output.
7. Confirm the stable Preview domain resolves to the new deployment.

Do not promote the Preview deployment to Production and do not merge to `main`
at this stage.

## Phase 6: Preview verification

### Metadata smoke test

```bash
PREVIEW_ORIGIN=https://mcp-oauth-preview.respan.ai

curl -fsS "$PREVIEW_ORIGIN/.well-known/oauth-protected-resource"
curl -fsS "$PREVIEW_ORIGIN/.well-known/oauth-authorization-server"
curl -fsS "$PREVIEW_ORIGIN/.well-known/oauth-protected-resource/enterprise"
curl -fsS "$PREVIEW_ORIGIN/enterprise-oauth/.well-known/oauth-authorization-server"
```

Verify:

- the platform resource is
  `https://mcp-oauth-preview.respan.ai/mcp`;
- the enterprise resource is
  `https://mcp-oauth-preview.respan.ai/mcp/enterprise`;
- authorization, registration, and token endpoints use the Preview origin;
- `authorization_code` and `refresh_token` are advertised;
- no endpoint redirects to a Vercel login page.

### Complete hosted OAuth test

Run the test with Conductor and at least one second hosted MCP client:

1. Configure the client with:

   ```text
   https://mcp-oauth-preview.respan.ai/mcp
   ```

2. Start OAuth discovery and dynamic client registration.
3. Confirm the login page displays the requesting client and exact redirect.
4. Authenticate with an approved test account.
5. Approve the client.
6. Confirm the MCP client receives an opaque `mcp_at_...` access token and
   `mcp_rt_...` refresh token, never backend JWTs.
7. Initialize MCP and call one read-only tool.
8. Wait at least 61 seconds.
9. Confirm the old access token repeatedly returns HTTP 401 with the canonical
   `WWW-Authenticate` challenge.
10. Refresh with the current `mcp_rt_...` token.
11. Confirm both opaque MCP tokens change.
12. Confirm the new access token initializes MCP and calls the same tool.
13. Reuse the spent refresh token and confirm OAuth `invalid_grant`.
14. Confirm reuse of the spent token did not revoke the newer token pair.
15. Repeat the test for `/mcp/enterprise` if enterprise login is in release
    scope.

The local `npm run verify:oauth:local` command launches its own localhost
harness; it does not target the hosted Preview. Do not report that local command
as hosted Preview proof.

### Failure tests

Verify in Preview:

- Missing, malformed, expired, or wrong-resource `mcp_at_...` returns 401.
- A non-MCP bearer credential follows the API-key path and never falls through
  from an OAuth failure.
- A backend access JWT produced by direct `/login` still initializes MCP and
  calls a tool without a Redis operation.
- Redis unavailability during MCP access validation produces 503 with
  `Retry-After`, not 401.
- Temporary Redis, backend network, or backend 5xx errors during refresh return
  `temporarily_unavailable` without consuming the current refresh token.
- Backend 401 for a stored backend access JWT removes only the access record and
  preserves the refresh session.

Do not deliberately disable or clear a shared service to simulate failures.
Use an isolated test resource or mocked automated coverage.

### Credential-leak inspection

Inspect:

- Browser Network response bodies.
- Browser local storage, session storage, cookies, and page source.
- MCP client request and response logs.
- Vercel build and function logs.
- Upstash key names.

Backend JWTs, raw MCP tokens, authorization codes, Redis tokens, and
`OAUTH_SECRET` must not appear. Do not reveal a secret merely to perform this
inspection.

## Phase 7: provision Production Upstash

After the Preview gate passes:

1. Create a separate Upstash database named `keywordsai-mcp-production`.
2. Choose the approved production plan.
3. Configure a $10 monthly budget cap and usage alerts when supported.
4. Connect it to `keywordsai-mcp` with **Production** scope only.
5. Verify the exact `UPSTASH_REDIS_REST_*` variable names.
6. Confirm Production uses its own `OAUTH_SECRET`.
7. Confirm the key prefix is `respan-mcp:production:`.
8. Confirm the access-token TTL is `14400`, not the Preview value `60`.
9. Confirm `MCP_PUBLIC_BASE_URL` is exactly `https://mcp.respan.ai`.

Never point Production at the Preview database as a shortcut.

## Phase 8: Production deployment

1. Record the current known-good Production deployment and commit SHA.
2. Confirm the Production environment-variable targets and values.
3. Confirm all required Preview tests passed.
4. Create and review the pull request.
5. Merge the approved pull request into `main`.
6. Watch the Vercel Production build.
7. Confirm the deployed commit and successful build.
8. Verify Production metadata before testing login.
9. Complete one Production OAuth login, MCP initialization, and read-only tool
   call.
10. Confirm existing OAuth clients are prompted to authenticate once after the
    broker cutover.
11. Confirm the independent API-key path still works.

Do not change global backend JWT policies or enable backend refresh-token
rotation as part of this deployment.

## Monitoring

During the first rollout, monitor:

- OAuth authorization and token endpoint 4xx/5xx rates.
- `invalid_grant` rates, separated from temporary failures.
- MCP 401 responses for invalid or expired opaque access tokens.
- MCP and OAuth 503 responses caused by Redis unavailability.
- Refresh success, refresh lock contention, and temporary refresh failures.
- Backend refresh 401 and 5xx responses.
- Function duration and timeout rates.
- Upstash command volume, storage, and billing.

Expected behavior:

- Expired access tokens create 401 responses until the client refreshes.
- Reuse of an already rotated refresh token returns `invalid_grant`.
- A temporary dependency failure does not consume the current refresh token.
- API-key traffic does not create Redis activity.

Alert-worthy behavior:

- Backend tokens or raw MCP tokens appearing in logs.
- A sustained increase in Redis 503 responses.
- Refresh sessions being lost after temporary failures.
- New valid token pairs being revoked by spent-token reuse.
- Preview records appearing under the Production prefix or database.
- Production issuing `expires_in: 60`.

## Rollback

The preferred rollback is a Vercel deployment rollback, not destructive Redis
cleanup:

1. Reassign the Production domains to the recorded known-good deployment using
   Vercel's rollback flow.
2. Do not delete or flush either Redis database.
3. Leave new broker records to expire through their TTLs.
4. Preserve logs needed for incident investigation without preserving secret
   values.
5. Document whether users must authenticate again.

If a secret is exposed:

1. Treat the affected environment as compromised.
2. Rotate its `OAUTH_SECRET` and Upstash token.
3. Do not reuse the other environment's credentials.
4. Expect affected sessions to require reauthentication.
5. Review Vercel and Upstash access logs.
6. Follow the organization's incident-response process.

## Final checklist

### Access and services

- [ ] Operator has the required Vercel role or permission groups.
- [ ] Upstash is installed for the Respan team.
- [ ] Preview and Production use separate Upstash databases.
- [ ] Preview has a stable domain.
- [ ] The dedicated Preview domain is exempt from Vercel Authentication.
- [ ] Other Preview deployments remain protected.
- [ ] Git Integration still targets `respanai/respan-mcp`.
- [ ] Production still tracks `main`.

### Variables

- [ ] Exact `UPSTASH_REDIS_REST_*` names exist.
- [ ] Preview and Production `OAUTH_SECRET` values differ.
- [ ] Preview and Production Redis credentials differ.
- [ ] Preview and Production key prefixes differ.
- [ ] Preview TTL is `60`.
- [ ] Production TTL is `14400`.
- [ ] Preview uses the stable Preview origin.
- [ ] Production uses `https://mcp.respan.ai`.
- [ ] `RESPAN_API_KEY` is absent.
- [ ] Test credentials are absent.

### Verification

- [ ] `npm test` passes.
- [ ] `npm run build` passes.
- [ ] `git diff --check` passes.
- [ ] Preview metadata uses the Preview origin.
- [ ] Preview login and client confirmation succeed.
- [ ] The initial opaque access token works.
- [ ] The access token expires after the configured TTL.
- [ ] Refresh rotates both tokens.
- [ ] The refreshed access token works.
- [ ] Spent refresh reuse returns `invalid_grant`.
- [ ] A second hosted MCP client passes.
- [ ] API-key behavior remains independent of Redis.
- [ ] No credential leakage is found.

### Production

- [ ] The Preview gate is approved.
- [ ] The previous Production deployment is recorded for rollback.
- [ ] Production variables are reviewed by environment target.
- [ ] The approved pull request is merged to `main`.
- [ ] Production metadata, login, MCP initialization, and a read-only tool pass.
- [ ] Monitoring and Upstash usage alerts are active.
