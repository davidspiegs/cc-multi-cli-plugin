# Verify the normal Claude command and worker effort

This opt-in test uses existing Claude and Codex authentication. It sends one bounded
synthetic task to the installed command, so it consumes provider usage. Install the
normal-command bridge and set the user's default model before running it.

```sh
node test/live/native-worker-effort.ts \
  --command "$HOME/.local/share/multi-cli/bin/claude" \
  --artifacts /absolute/path/to/new-test-artifacts
```

The test deliberately supplies neither `--model` nor `--effort`. It reads user and
synthetic-project settings so the installed user model default is exercised. It
does not edit user settings or change saved model defaults. For a different launch
form, `--command` names the executable and repeated `--command-arg` options supply
its initial arguments. Model and effort flags in those arguments are rejected.

The assertions require actual response and gateway evidence:

- Parent assistant responses remain `claude-opus-5-5`, with a successful Anthropic request.
- The parent calls `multi-openai` once without overriding its model or effort.
- The native worker transcript identifies `multi/openai/gpt-6-astra`.
- Every OpenAI request belongs to that worker and sends `model: gpt-6-astra` and
  `effort: max` in the gateway's request trace.
- Native Read and Edit run successfully, an inherited local MCP tool executes,
  and exactly one Bash permission probe receives an actual denial.
- A synthetic project marker appears in the child response without being copied
  into the delegated prompt or fetched from `CLAUDE.md`.

The native Agent spawn API does not expose per-task effort. This test checks the
fixed Max worker default and records that limitation; it does not claim a lower
effort override works.

The fixture uses `dontAsk`, explicit allowed tools, a deny rule for the exact Bash
probe command that overrides any user Bash allow, and a strict local MCP config.
The deny is command-scoped because denying the entire Bash tool removes it from
the native toolset. The denial assertion checks the native permission-denial text,
not just a generic tool error.
Only its synthetic workspace is modified by the task. Each run has a three-minute
timeout, a ten-parent-turn limit and a $1.50 Claude budget. Existing user settings,
including configured hooks, remain active because the default-model setting is
part of the behavior being verified.

The artifact directory contains `report.json`, the native lead/worker transcripts,
gateway stderr traces, local fixture observations, and Claude's debug log. No
credential file is copied. Use a new artifact directory for each run.
