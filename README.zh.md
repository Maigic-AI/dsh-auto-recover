# dsh-auto-recover

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **Host 插件**：当会话因服务商额度错误被卡住后，额度一旦恢复，就自动续跑该会话。

> 额度恢复后，自动续跑之前被限额卡住的会话。

## 功能

- **检测**额度耗尽：从模型请求错误（`QUOTA` / `RATE_LIMIT`）识别，适用于任意会话（无论是否开启了 `/goal`）。
- **轮询**服务商额度直到恢复，然后：
  - goal 会话：重新武装 goal（`goals.resume`），由 goal round driver 继续执行；
  - 普通会话：注入一条「继续」后续消息，重新开启回合。
- **提供**控制与状态入口：`/auto_recover` 命令，以及 `auto_recover_status` 模型工具。

## 支持的额度来源

| 服务商 | 接口 | 「已恢复」的判定 |
| --- | --- | --- |
| **DeepSeek** | `GET https://api.deepseek.com/user/balance` | `is_available` 为真且总余额 > 0 |
| **z.ai / GLM**（国际版） | `GET https://api.z.ai/api/monitor/usage/quota/limit` | 最短的 `TOKENS_LIMIT`/`CREDIT_LIMIT` 的 `remaining > 0`，或已过其 `nextResetTime` |
| **z.ai / GLM**（BigModel 国内，如 `zai-coding-cn`） | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | 同上 |

z.ai 编码套餐的重置时间也会直接从服务商错误信息里解析（例如「已达到 5 小时的使用上限。您的限额将在 2026-08-15 12:00:47 重置。」），因此即使额度 API 不可达，仍能显示预计恢复时间。

## 凭证

插件通过 harness 的凭证服务（`ctx.credentials`）解析 API 密钥，该服务读取进程环境变量与 `$DSH_HOME/.credentials.yaml`。

- DeepSeek：`DEEPSEEK_API_KEY`（回退 `DEEPSEEK_KEY`）
- z.ai：先从设置（`llm-pi-ai`）中自动发现当前 pi-ai 路由的 `apiKeyEnv`，再依次回退到 `ZAI_CODING_CN_API_KEY`、`Z_AI_API_KEY`、`BIGMODEL_API_KEY`、`ZHIPU_API_KEY`、`ZHIPUAI_API_KEY`、`GLM_API_KEY`。

## 安装

### 1. 安装插件包

从 npm 发布版安装：

```bash
cd "$DSH_HOME/profiles/web"   # 或你的 profile 目录
pnpm add @maigic/dsh-auto-recover
```

从 git 仓库安装（无需发布到 npm）：

```bash
cd "$DSH_HOME/profiles/web"
pnpm add github:Maigic-AI/dsh-auto-recover
```

本地开发（把仓库链接进 profile 的 `node_modules`）：

```bash
# macOS / Linux
ln -s /path/to/dsh-auto-recover "$DSH_HOME/profiles/node_modules/dsh-auto-recover"
# Windows（junction，无需管理员权限）
New-Item -ItemType Junction -Path "$env:DSH_HOME\profiles\node_modules\dsh-auto-recover" -Target "D:\path\to\dsh-auto-recover"
```

### 2. 添加组合行

编辑 profile 的 patch 文件 `$DSH_HOME/profiles/<name>/cordis.patch.yml`（或 home 级 `$DSH_HOME/cordis.patch.yml`），加入：

```yaml
- insert:
    - id: auto-recover
      name: '@maigic/dsh-auto-recover'
```

### 3. 生效

profile watcher 会热应用 `cordis.patch.yml` 的改动；否则重启 harness。

## 使用

在任一会话中：

```
/auto_recover           # 查看状态（同 `status`）
/auto_recover on        # 为当前会话开启自动恢复
/auto_recover off       # 关闭
```

模型也可以调用 `auto_recover_status` 工具读取当前状态。

开启后，一旦发生额度错误，会话会被标记为「卡住」；插件会轮询（每 30 秒，已知重置时间后降频为 5 分钟一次），额度恢复后自动续跑。

## 组合位置（重要）

本插件是**进程级全局**的：它监听每个 agent 的 `agent/request-error`，并跨会话续跑。请把它**挂载一次到 host/profile 组合**，而不是逐个 agent preset——否则每个会话都会跑一份副本，导致重复检测/轮询/续跑。

## 架构

- `lib/index.js` —— Host 插件（纯 ESM，无需构建步骤）。
- `client/` —— 可选的会话 UI 脚手架（见 `client/README.md`）。

Client 半边（可视化开关 + 状态行）的移植代码位于 `client/`，但需要 DeepSeek Harness 的 client 构建工具链（tsdown 打包 + Typert Remote），因此以参考源码形式提供，而非已构建的 bundle。

## 持久化

每个会话的自动恢复开关持久化在 harness 设置文档（`$DSH_HOME/settings.yaml`）的 `auto-recover` 命名空间下：

```yaml
auto-recover:
  sessions:
    - session-abc
    - session-def
```

`/auto_recover on` 会把当前会话 id 加入；`off` 会移除。插件加载时会重新读取该列表，因此已开启的会话在 harness 重启后依然有效。若 `settings` 服务不可用，插件会降级为内存态。

## 限制

- 「卡住」（当前被限额）的检测是运行时状态，不持久化：重启后，会话会在下一次额度错误时重新检测。
- 续跑针对仍存活（idle）的会话；因进程重启而被销毁的会话不会重新驱动（那需要 `agentLoop.resume`）。
- 目前只实现了 DeepSeek 与 z.ai / GLM 两种额度来源。

## License

MIT
