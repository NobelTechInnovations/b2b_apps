# AI assistant and company MCP connections

The assistant and MCP use the existing gateway, company membership, app access,
permissions and record visibility rules. A connection cannot choose another
company. Each user creates their own connection in **Settings → AI & agents**
(**AI & agents** in the employee portal).

## Model configuration

Keep keys in the server environment, never in `.env.example` or a browser variable.
For the local Supabase review runner, use ignored `.env.local`:

```dotenv
AI_PROVIDER=nvidia
NVIDIA_API_KEY=your_nvidia_key
NVIDIA_API_URL=https://integrate.api.nvidia.com/v1/chat/completions
SUPPORT_AI_MODEL=nvidia/nemotron-3-ultra-550b-a55b
```

To select Anthropic, use its native Messages API and a key issued by Anthropic:

```dotenv
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_key
ANTHROPIC_API_URL=https://api.anthropic.com/v1/messages
SUPPORT_AI_MODEL=claude-sonnet-5-5
```

NVIDIA and Anthropic keys are not interchangeable. No automatic cross-provider
fallback sends data or credentials to another provider. `AI_API_KEY`, `AI_BASE_URL`
and `AI_MODEL` remain compatible with previous NVIDIA configurations. Explicit
provider keys take precedence; `SUPPORT_AI_MODEL` overrides `AI_MODEL`.
Restart the AI service after changing server environment variables.

The settings page says **API key configured** until **Test connection** succeeds.
An API key being present does not establish availability or authentication.
Temporary overload responses receive one retry, then a specific error; provider
error bodies and credentials are never sent to the browser. Empty answers are
reported as failures instead of pretending the model replied.

Normal questions can omit page/field context or send an empty field label. A
field-help button sends the label and hint, not the form's values. Guidance mode
does not read company records. With company data enabled, reads use the user's
permissions and writes become expiring proposals. The user must apply a proposal
through the separate authenticated endpoint; each proposal can execute once.

## MCP deployment and client setup

The endpoint is `/api/mcp`, using stateless MCP Streamable HTTP and a Nexus
connection token in `Authorization: Bearer …`. Tokens are shown once, stored as
hashes, limited to selected apps, read-only by default, expire within 90 days and
can be revoked by their user or a company owner. Removing membership or revoking
the associated session also disables the connection.

Configure trusted deployment domains in the gateway and AI service. For this
deployment:

```dotenv
APP_URL=https://kartikmaandothiya.fun
ROOT_DOMAIN=kartikmaandothiya.fun
# Optional explicit endpoint / additional hostname:
MCP_PUBLIC_URL=https://flp-worldwide-9491.kartikmaandothiya.fun/api/mcp
```

The policy derives trusted hosts/origins from `APP_URL`, `WEB_ORIGIN`, `API_URL`
and `MCP_PUBLIC_URL`. `ROOT_DOMAIN` permits the root and a single company
subdomain; lookalike suffixes and unrelated origins are refused. Explicit
`MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` extend this list. Never use `*`.

On the older deployed code, a configuration-only remedy is adding the exact
hostname to `MCP_ALLOWED_HOSTS` and the HTTPS origin to `MCP_ALLOWED_ORIGINS`.
Those environment changes must be applied to the deployed services; changing
files locally does not update a hosted server.

Client JSON formats vary. Clients with HTTP bearer support can use:

```json
{
  "mcpServers": {
    "nexus": {
      "type": "http",
      "url": "https://flp-worldwide-9491.kartikmaandothiya.fun/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_NEXUS_CONNECTION_TOKEN" }
    }
  }
}
```

For this project's Codex connection, `.codex/config.toml` starts
`services/ai/scripts/mcp-bridge.js`. The bridge reads the following values from
ignored `.env.local`, so the credential is absent from configuration and command
arguments:

```dotenv
NEXUS_MCP_URL=https://flp-worldwide-9491.kartikmaandothiya.fun/api/mcp
NEXUS_MCP_TOKEN=your_nexus_connection_token
```

Reload MCP connections or open a new Codex session after changing its config.
`pnpm mcp:check` initializes the real HTTP client and lists accessible apps without
reading business records or making changes.

Tools: `list_apps`, `find_actions`, `describe_action`, `read_action`, `write_action`.
Action schemas come from guarded, registered JSON routes. The original handlers
remain responsible for validation and record visibility. Internal/public routes,
credential routes, file transfers and routes without declared permission guards
are not advertised. New compatible guarded routes are discovered automatically.
Read-only connections do not advertise writes. External agents with write access
can execute changes; their own client controls user confirmation.

OAuth-only remote clients are not supported yet. A remote hosted agent cannot
reach localhost. The stdio bridge supports local clients using bearer credentials.
AI operation history is scoped by company and user and stores action metadata,
not credentials or record contents.

## Local review and checks

`pnpm dev:review` uses the configured Supabase database with separate
`ai_review_*` schemas and event bus, local service URLs, a small connection pool
and external email disabled. It does not deploy or migrate the production
`nexus_*` schemas. A small Supabase instance may need only the services being
reviewed started, or a separate development project for the whole suite.

```sh
pnpm test:ai
pnpm smoke:ai  # requires the local gateway and test workspace services
pnpm mcp:check
```

October 7 fixes: empty-field chat validation, native NVIDIA/Anthropic adapters,
specific provider failures, real connection check, trusted company-domain MCP
policy, and the project Codex bridge. Targeted tests cover both API formats,
tool-result round trips, tenant/permission boundaries, credentials, retries and
the exact empty-field regression.

Official references: [NVIDIA Nemotron API](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-ultra-550b-a55b-infer),
[Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create),
[Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
