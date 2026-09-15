# Goal liveness reconciliation

## USER OBSERVATION

通过远程界面看到 Worker / Goal 长时间没有明显变化，并怀疑可能停在选择“8 月工资表”的系统文件选择器附近。用户没有观察到服务端 `active` 状态。

## CONFIRMED FACT

- 独立调用 `thread/goal/get` 返回 Goal `status=active`。
- 记录中的 `tokensUsed=674701`、`timeUsedSeconds=1832`，但没有 Worker terminal result。
- 没有 `worker_output.json`，RUN_STATE 仍为 `WORKER/running`，goal artifact 仍为 `active`。
- 停止本地 app-server 后，服务端 Goal 仍显示 `active`；手动设置 `paused` 后 token/time 才停止增长。
- Ralph 缺少 meaningful-progress 与 stalled reconciliation。

## TECHNICAL ASSESSMENT

Goal service status、transport liveness 和 meaningful progress 被混为一谈；一次 `active` 观察可能导致长时间盲等。

## DECISION

采用周期性 `thread/goal/get`、同 thread 重连、workspace/agent/artifact 进展证据、可配置 stall threshold，以及显式 pause-and-confirm。

## UNKNOWN

- 未确认 terminal notification 是否丢失。
- 未确认原生 file picker 是根因。
- Worker 很可能卡在 UI 自动化路径，但没有足够证据把它定为根因。
