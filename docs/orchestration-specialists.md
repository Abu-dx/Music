# Orchestration Specialists Configuration

本文档用于说明 orchestration specialist（guitar / piano）的配置来源、缺失项判断和最小验收流程。

## 1. 配置读取顺序

当前读取顺序固定为：

1. 环境变量（`env`）
2. 持久化配置（`persisted`）
3. 默认值（`default`）

即：`env > persisted config > default`。

软件内 ResultPage 的 Orchestration 调试区会显示每个 specialist 的 `configSource`。

## 2. 持久化配置文件路径

主进程会把 specialist 配置写入：

- `%APPDATA%/../Roaming/<AppName>/orchestration-specialists.json`（由 Electron `app.getPath('userData')` 决定）

代码路径：`path.join(app.getPath('userData'), 'orchestration-specialists.json')`。

## 3. Guitar Specialist 必要字段

当 `enabled=true` 时，至少需要：

- `modelId`
- `runtimeProfileId`
- `cmd`
- `checkpoint`

常见环境变量：

- `ORCH_GUITAR_SPECIALIST_ENABLED`
- `ORCH_GUITAR_SPECIALIST_MODEL_ID`
- `ORCH_GUITAR_SPECIALIST_RUNTIME_PROFILE_ID`
- `ORCH_GUITAR_SPECIALIST_CMD`
- `ORCH_GUITAR_SPECIALIST_CHECKPOINT`

## 4. Piano Specialist 必要字段

当 `enabled=true` 时，至少需要：

- `modelId`
- `runtimeProfileId`
- `cmd`
- `checkpoint`

常见环境变量：

- `ORCH_PIANO_SPECIALIST_ENABLED`
- `ORCH_PIANO_SPECIALIST_MODEL_ID`
- `ORCH_PIANO_SPECIALIST_RUNTIME_PROFILE_ID`
- `ORCH_PIANO_SPECIALIST_CMD`
- `ORCH_PIANO_SPECIALIST_CHECKPOINT`

## 5. 状态语义

- `not_configured`：未启用或关键字段缺失
- `health_failed`：health check 失败（如 checkpoint 不存在）
- `selected`：specialist 成功执行并被选中覆盖目标 stem
- `fallback_to_baseline`：specialist 失败或不可用，目标 stem 回退到 baseline

ResultPage 调试区会同时显示：

- `configSource`
- `missingFields`
- `blocker`

用于直接判断为什么当前是 `not_configured`。

## 6. 最小手工验收步骤

1. 打开项目，执行一次 `Orch 编排分离`。
2. 在 ResultPage 调试区确认：
   - `currentResultSetId/currentResultSetKind`
   - guitar/piano 的 `configSource`
   - `missingFields` 与 `blocker`
3. 先在不配 piano 的情况下验证：
   - piano 显示 `not_configured`
   - `missingFields` / `blocker` 明确说明原因。
4. 补齐某 specialist 的 `cmd + checkpoint + runtimeProfileId + modelId` 后再跑：
   - 预期状态从 `not_configured` 进入 `selected` 或 `fallback_to_baseline`（失败注入场景）。
5. 重启应用后再次执行 orch：
   - 若未改 env，仍应可从 `persisted` 恢复配置，不应无故回到默认空配置。
