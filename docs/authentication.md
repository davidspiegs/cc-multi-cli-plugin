# Authentication and subscription usage

Authentication, model access, and billing are separate checks. A saved login or
model catalog does not prove that a particular request is available or included
in a plan. The following reflects the implementation and official documentation
reviewed on October 19, 2026.

| Provider | Current integration | Subscription and execution boundary |
| --- | --- | --- |
| Claude | Claude Code's own subscription login or API credentials pass through the gateway. | Claude Code owns tools and history. Separate `CLAUDE_CONFIG_DIR` values isolate login storage, including macOS Keychain entries. This plugin does not pool Claude accounts. [Claude authentication](https://code.claude.com/docs/en/authentication) |
| OpenAI / ChatGPT | The OpenAI adapter reads Codex's saved ChatGPT login and asks Codex to renew it. It calls the Codex backend Responses endpoint. | Claude Code owns tools and history. This is an **experimental compatibility integration**, distinct from the registered Sign in with ChatGPT flow below. [Current adapter](openai.md), [Codex authentication](https://learn.chatgpt.com/docs/auth) |
| OpenCode | The current Zen adapter uses an OpenCode API key for direct model requests. | Claude Code owns tools and history. **Zen and Go are distinct routes; Go is not enabled in this fork.** Go supports other coding agents, but needs its Go endpoints, eligible models, client identification, and conversation session headers. A Zen connection does not establish Go entitlement. [Zen setup](zen.md), [Go requirements](https://opencode.ai/v2/docs/console/go/) |
| Cursor | The official Cursor SDK uses its own login or `CURSOR_API_KEY`. | Cursor owns the agent loop, tools, and state. SDK runs use the applicable account/team usage pool; the SDK is not a raw model inference API. [Cursor SDK](https://cursor.com/docs/sdk/typescript) |
| Grok | The official Grok Build CLI uses its browser login. This adapter removes `XAI_API_KEY` from the child environment to preserve that authentication choice. | Grok owns the agent loop, tools, and state. A direct xAI model adapter is not implemented. Current SuperGrok documentation includes API usage in its weekly pool, but eligibility and billing depend on the account and plan. [Build](https://docs.x.ai/build/overview), [SuperGrok usage](https://docs.x.ai/grok/faq) |
| Devin | No adapter is implemented in this fork. | Devin's documented API, MCP, and Claude Code Handoff plugin delegate to Devin sessions. They do not expose a raw model for Claude Code's native tool loop. [Devin API](https://docs.devin.ai/api-reference/overview), [Handoff](https://docs.devin.ai/work-with-devin/devin-handoff) |

Current X Subscription plans share eligible first-party Grok/Cursor usage and
charge third-party Cursor models as Additional Usage. Legacy and current plans
can differ; check the selected account's live billing view before assuming an
included allowance. [Usage rules](https://docs.x.ai/x-subscription/usage-limits)

## OpenAI: existing Codex adapter and registered OAuth

The current adapter sends requests to
`https://chatgpt.com/backend-api/codex/responses`. Codex owns login and renewal;
the gateway uses its saved access token. Official Codex documentation describes
credential reuse between Codex clients and headless installations, but does not
document this third-party direct-inference adapter. Its backend behavior can
change independently of the public API contract.

The official **Sign in with ChatGPT** integration is a separate route, available
to open-source clients and selected private clients. It is not implemented here.
Initial registration uses `dynamic_agent_client`, an app name, a stable host ID,
and browser consent with PKCE. The callback supplies an issued client ID; the app
validates identity and granted inference scopes, then stores and refreshes its
own credential record. Existing Codex tokens are not documented as substitutes
for that registration. [Availability](https://developers.openai.com/siwc/quickstart),
[Registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

That flow uses `https://api.openai.com/v1/responses` with an authorized OAuth
bearer token, `store: false`, and `stream: true`. Its documentation explicitly
directs clients away from ChatGPT backend endpoints. Migrating requires an auth
and request adapter, not only a URL change: tool encoding has additional
requirements, and availability of the current `codex-auto-review` reviewer is
not established by the public flow. [Inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference),
[Protocol limits](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

## Anthropic monthly promotional API credits

Monthly credits belong to the eligible linked Console organization and are
shared across its API keys. Creating another key does not create another grant.
Unused credits expire at the end of the applicable billing cycle.

These credits **exclude interactive Claude Code** in the terminal, IDE,
Desktop, and web. Using an API key in an interactive plugin session does not
establish eligibility. The promotion explicitly covers self-run `claude -p`
and Agent SDK usage with the linked Console API key; runs started through
Claude Code's GitHub Action, IDE extension, or Desktop remain excluded.

Keep subscription use and any headless API-credit workflow explicitly separate.
This fork's interactive Claude route should not be described as consuming the
promotional grant. Purchased credits or automatic reload may fund eligible
requests after a grant runs out, depending on account settings.
[Official eligibility and exclusions](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)
