# Workload Identity Federation — keyless Anthropic auth

> Replaces the long-lived `ANTHROPIC_API_KEY` in prod (Fly) and the nightly eval
> (GitHub Actions) with short-lived tokens. Code: `web/anthropic-client.js`.
> Tests: `web/tests/unit/anthropic-client.test.js`.

## How it works

The workload gets a signed identity token (JWT) from its platform, the SDK
exchanges it at `POST /v1/oauth/token` for a short-lived Anthropic access token
(`sk-ant-oat01-…`), and refreshes it before expiry. Nothing secret is stored.

`createAnthropicClient()` picks the credential source in this order:

| Order | Source | When |
|---|---|---|
| 1 | `ANTHROPIC_API_KEY` | Local dev, the sim, and any environment not yet cut over. Always wins. |
| 2 | Token file / inline token | `ANTHROPIC_IDENTITY_TOKEN_FILE` or `ANTHROPIC_IDENTITY_TOKEN` |
| 3 | GitHub Actions OIDC | `ACTIONS_ID_TOKEN_REQUEST_URL` present (job has `id-token: write`) |
| 4 | Fly Machine OIDC | `FLY_APP_NAME` set and `/.fly/api` socket exists |
| — | none | Calls fail with a clear error. Never falls back to a local `ant` login, so tests can't make real calls. |

Federation (2–4) also needs `ANTHROPIC_FEDERATION_RULE_ID` and
`ANTHROPIC_ORGANIZATION_ID`; `ANTHROPIC_SERVICE_ACCOUNT_ID` and
`ANTHROPIC_WORKSPACE_ID` are optional. None of these IDs are secrets.

Every token is requested with audience **`https://api.anthropic.com`** — the
federation rules must match that exact value.

The agent loop logs which source won at startup: `auth=api_key`,
`auth=federation:fly`, etc.

## Console setup (one time, needs an org admin)

Claude Console → **Settings → Workload identity → Connect workload**. Create
one connection per environment.

### Nightly eval (GitHub Actions)

- Provider tile: **GitHub Actions** (issuer `https://token.actions.githubusercontent.com`, discovery).
- Rule match:
  - `subject_prefix`: `repo:GeneralInfluence/ButterflAI:ref:refs/heads/main`
  - `audience`: `https://api.anthropic.com`
  - claims: `repository_owner = GeneralInfluence`
- Scope `workspace:developer`, lifetime 600s.
- Then in GitHub → repo **Settings → Secrets and variables → Actions → Variables**, add
  `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_SERVICE_ACCOUNT_ID`.
- Run the eval workflow manually once (it still uses the key — key wins), then
  **delete the `ANTHROPIC_API_KEY` repo secret** and run it again to confirm
  federation works.

Do not loosen the subject to `repo:…:*` — that also matches pull-request runs,
including from forks.

### Prod (Fly.io)

- Provider tile: **Custom OIDC**.
  - Issuer URL: `https://oidc.fly.io/sean-gonzalez`; JWKS: discovery.
    Note: this is NOT the `personal` slug that `flyctl orgs list` shows — read
    the real `iss` from a token on the machine (decoded 2026-10-02:
    `iss=https://oidc.fly.io/sean-gonzalez`,
    `sub=sean-gonzalez:butterflai:<machine-name>`, 10-minute lifetime, has `jti`).
- Rule match:
  - `subject_prefix`: `sean-gonzalez:butterflai:*` (Fly's `sub` is `org:app:machine`)
  - `audience`: `https://api.anthropic.com`
- Scope `workspace:developer`, lifetime 600s.
- Set the IDs on Fly (they are not secrets, but `fly secrets` is the simplest
  way to inject env):
  ```sh
  flyctl secrets set -a butterflai \
    ANTHROPIC_FEDERATION_RULE_ID=fdrl_... \
    ANTHROPIC_ORGANIZATION_ID=... \
    ANTHROPIC_SERVICE_ACCOUNT_ID=svac_...
  ```
- Cut over: `flyctl secrets unset -a butterflai ANTHROPIC_API_KEY`, then check
  the logs for `[agent] starting loop (... auth=federation:fly)` and send a
  test message. Rollback = set the key again (it takes precedence).
- Once stable, delete the old key in the Console under **Settings → API keys**.

Failed exchanges return an opaque 401; the reason is on the Console's
Workload identity → authentication history tab.
