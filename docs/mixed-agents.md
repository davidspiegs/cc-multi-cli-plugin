# Claude and GPT in one native agent session

OpenAI models and Claude models can lead or work as children inside Claude
Code. Claude Code owns the tool loop, permissions, agent lifecycle, and saved
transcripts in both directions. OpenAI inference uses the OpenAI connection;
native Claude inference uses the caller's existing Claude connection.

## Claude lead, GPT child

Start `claude-multi` with a Claude model selected, then ask:

> Use a multi-openai worker with model gpt-6.1-sol to implement the change and
> report its validation. Give it the relevant files, requirements, and constraints.

The worker's `model` selects one of the OpenAI models advertised in its type
description. Omitting it uses the OpenAI worker default. Its native tool calls
run through Claude Code and its final report returns to the lead.

## GPT lead, Claude child

Select `/model multi/openai/gpt-6.1-sol`, then ask:

> Use a multi-claude worker to review this change and report concrete findings.
> Give it the relevant files, requirements, and constraints.

The launcher offers `multi-claude` when Claude reports an available login or
the caller supplies native Anthropic authentication. It defaults to Sonnet 5.5.
Configure another Claude model for a launch with:

```sh
MULTI_CLAUDE_MODEL=opus claude-multi
```

Accepted values are `sonnet`, `opus`, `haiku`, `fable`, or a full `claude-*`
model ID. The launcher resolves aliases to concrete native IDs before spawning:

| Alias | Native worker model |
| --- | --- |
| `sonnet` | `claude-sonnet-5-5` |
| `opus` | `claude-opus-5-5` |
| `haiku` | `claude-haiku-5-5` |
| `fable` | `claude-fable-5-1` |

This mapping was checked against Claude Code 2.1.304's native catalog on
2026-10-19. Claude Code can resolve a bare family alias through the lead model's
behavior profile; a GPT lead with the Sonnet profile can therefore turn a
`sonnet` child back into GPT. Full native IDs avoid that ambiguity, and the
spawn hook refuses unresolved aliases or non-Claude models. Supply a full
`claude-*` ID to use another available version without changing this mapping.

`inherit`, `multi/` models, and whitespace are rejected. Omit the
Agent call's `model` to use this configured model. The setting has no effect
when Claude authentication is unavailable. Authentication detection does not
verify access to a particular model or make an inference request.

`multi-claude` is an ordinary native Claude agent. It is outside the external
provider catalog and uses the normal Anthropic route. Its registration does
not change the lead model or the user's Claude login.

## Tools, permissions, and context

Generated OpenAI, Zen, and Claude workers inherit the host's effective native
subagent tool pool, including available MCP tools. Claude Code still applies
permission rules, foreground/background tool filters, and nesting limits.
Custom agents retain their declared tool restrictions. These workers do not
gain permission to execute an action simply because its tool is available.

Each ordinary child receives its delegated task and native subagent context,
including the project instructions and environment the host supplies. It then
maintains its own transcript, which the host can resume. It does not receive
the lead's entire conversation or every file the lead has read automatically;
include relevant requirements, decisions, and file references in the handoff.

Do not use `fork: true` to switch providers. A native full-context fork retains
the parent's model and tool pool. Cross-provider delegation here uses ordinary
native subagents, with their normal context and report handback semantics.
