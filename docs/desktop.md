# Desktop integration status

The tested integration runs through the `claude-multi` CLI launcher. It does
not currently configure Claude Desktop's Code tab. Mods work in Desktop, but
loading the Mod alone does not connect the model gateway or register the
launcher's generated workers.

This boundary was checked against the official documentation and the generated
Claude Code 2.1.304 Mod API on October 20, 2026.

## Existing session routes

- **Desktop environment variables:** Desktop sets `ANTHROPIC_BASE_URL` itself
  in Claude-account sessions. A shell variable, saved environment, or settings
  override does not connect this gateway.
- **Remote Control:** a non-Anthropic `ANTHROPIC_BASE_URL` makes Remote Control
  unavailable, even with a native Claude subscription login.
- **Desktop handoff:** `/desktop` transfers the saved conversation and exits
  the CLI. It does not keep this launcher's gateway alive; the launcher cleans
  up its listener and temporary settings on exit.

Sources: [Desktop-owned variables](https://code.claude.com/docs/en/desktop#environment-variables-desktop-sets-itself),
[Remote Control requirements](https://code.claude.com/docs/en/remote-control#requirements),
[Desktop handoff](https://code.claude.com/docs/en/desktop#coming-from-the-cli).

## Separate gateway integration

Desktop's third-party inference mode is a possible integration target. It
requires a durable companion service, Desktop-compatible gateway authentication,
explicit model rows, and persistent worker delivery. It does not supply the
native Anthropic subscription authentication used by the current launcher.
Changing to that mode is an application-level provider change.

Claude API credentials could provide a separate upstream route. Anthropic's
monthly promotional API credits exclude Desktop usage, so this must not be
presented as a way to spend those grants. Account billing and provider selection
need an explicit choice before connecting that route.

Desktop supports gateway configuration, but Anthropic does not support
non-Claude models through it. GPT support would remain an experimental
compatibility integration.

Sources: [Desktop third-party configuration](https://claude.com/docs/third-party/claude-desktop/code),
[Gateway model configuration](https://claude.com/docs/third-party/claude-desktop/gateway#models),
[LLM gateway support](https://code.claude.com/docs/en/llm-gateway),
[Monthly credit eligibility](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans).

## Normal Desktop with a model-response Mod

A `turn.step` hook can supply response chunks while Claude remains on its native
connection. That is not yet a faithful substitute for this gateway's transport.
The current API exposes normalized conversation messages and separately
composed prompt sections, but not the complete outgoing request or arbitrary
native tool input schemas. Reconstructing a request from those partial views
would weaken the context and tool guarantees of this integration.

No Desktop transport implementation is included, and no native account is
replaced by installing this fork. The terminal resize fix does not change this
Desktop boundary.
