# OpenAI-compatible endpoints

`OpenAICompatibleProvider` serves any endpoint that speaks OpenAI's Chat Completions API with a
bearer key: OpenRouter, Together, Fireworks, DeepSeek, vLLM, LM Studio, and the like. It is
configuration over the shared [Chat Completions protocol](../../protocol/chatCompletions/README.md),
not a vendor reproduction: there is no native client to capture, so there are no `prompts/`,
`tools/`, or golden traces.

```text
OpenAICompatibleProvider -> shared Chat Completions session -> <endpoint>/chat/completions
```

The caller supplies the endpoint, key, vendor display name, and every model it may select. Each
model declares its input types, accepted `reasoning_effort` values, and extra request fields.
Provider-wide extras such as OpenRouter's `reasoning: { enabled: true }` are merged into every
request, model extras win over them, and protocol-owned fields cannot be replaced. Effort is sent
only when a model declares efforts; `off` is sent as `none`. Images are refused before transport
for text-only models.

Compaction uses Claude Code's non-Claude summary prompt and continuation, the same contract GLM
uses, because Rig gives these models Claude Code's harness shape.

Not supported: the Responses API, server tools, and grammar tools.

Live coverage: `tests/openAICompatible.live.test.ts` with `RIG_LIVE_TEST=1` and
`OPENROUTER_API_KEY`; `OPENROUTER_LIVE_MODELS` selects other models.
