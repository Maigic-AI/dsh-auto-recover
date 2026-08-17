# dsh-auto-recover

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **Host plugin** that automatically resumes sessions that stalled on a provider quota error — once the quota is replenished.

> 额度恢复后，自动续跑之前被限额卡住的会话。

## What it does

- **Detects** quota exhaustion from the model request error (`QUOTA` / `RATE_LIMIT`), for any session (with or without `/goal`).
- **Polls** the provider quota until it recovers, then:
  - goal sessions: re-arms the goal (`goals.resume`) so the goal round driver continues;
  - ordinary sessions: injects a "continue" follow-up message to reopen the turn.
- **Surfaces** control and status through a `/auto_recover` command and an `auto_recover_status` model tool.

## Supported quota sources

| Provider | Endpoint | "Recovered" means |
| --- | --- | --- |
| **DeepSeek** | `GET https://api.deepseek.com/user/balance` | `is_available` and total balance > 0 |
| **z.ai / GLM** (global) | `GET https://api.z.ai/api/monitor/usage/quota/limit` | shortest `TOKENS_LIMIT`/`CREDIT_LIMIT` has `remaining > 0` or its `nextResetTime` passed |
| **z.ai / GLM** (BigModel CN, e.g. `zai-coding-cn`) | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | same as above |

The z.ai coding-plan reset time is also parsed directly from the provider error message (e.g. `已达到 5 小时的使用上限。您的限额将在 2026-08-15 12:00:47 重置。`), so the ETA shows even when the quota API is unreachable.

## Credentials

The plugin resolves API keys through the harness credential service (`ctx.credentials`), which reads the process environment and `$DSH_HOME/.credentials.yaml`.

- DeepSeek: `DEEPSEEK_API_KEY` (fallback `DEEPSEEK_KEY`)
- z.ai: it first discovers the current pi-ai route's `apiKeyEnv` from settings (`llm-pi-ai`), then falls back to `ZAI_CODING_CN_API_KEY`, `Z_AI_API_KEY`, `BIGMODEL_API_KEY`, `ZHIPU_API_KEY`, `ZHIPUAI_API_KEY`, `GLM_API_KEY`.

## Install

1. Install the package into the harness's `node_modules` (the Loader resolves plugins by package name):

   ```bash
   npm install dsh-auto-recover
   # or, from a git checkout:
   # npm install <path-or-git-url>
   ```

2. Add one row to the **host composition** (process-global, one instance — see `cordis.snippet.yml`):

   ```yaml
   - id: auto-recover
     name: dsh-auto-recover
   ```

3. Restart the harness (or reload the composition).

## Usage

In any session:

```
/auto_recover           # show status (same as `status`)
/auto_recover on        # enable auto-recovery for this session
/auto_recover off       # disable
```

The model can also call the `auto_recover_status` tool to read the current state.

When enabled and a quota error hits, the session is marked "stuck"; the plugin polls (every 30 s, throttled to 5 min once a reset time is known) and resumes the session automatically on recovery.

## Composition placement (important)

This plugin is **process-global**: it listens to every agent's `agent/request-error` and resumes across sessions. Mount it **once in the host composition**, not per-session in an agent preset — otherwise every session would run its own copy and duplicate detection/polling/resume.

## Architecture

- `lib/index.js` — the Host plugin (pure ESM, no build step).
- `client/` — scaffold for an optional session UI (see `client/README.md`).

Ports for the Client half (a visual toggle + status line) live in `client/` but require the DeepSeek Harness client build toolchain (tsdown bundling + Typert Remote), so they ship as a reference rather than a built bundle.

## Persistence

Each session's auto-recover flag is persisted in the harness settings document (`$DSH_HOME/settings.yaml`) under the `auto-recover` namespace:

```yaml
auto-recover:
  sessions:
    - session-abc
    - session-def
```

`/auto_recover on` adds the current session id; `off` removes it. The plugin re-reads this list on load, so enabled sessions survive a harness restart. If the `settings` service is unavailable, the plugin falls back to in-memory state.

## Limitations

- The "stuck" (currently quota-limited) detection is runtime state and is not persisted: after a restart, a session re-detects on its next quota error.
- Resume targets a still-live (idle) session; a session destroyed by a process restart is not re-driven (that would need `agentLoop.resume`).
- Only DeepSeek and z.ai / GLM quota sources are implemented.

## License

MIT
