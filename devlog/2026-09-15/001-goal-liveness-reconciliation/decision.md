# Durable decision

## Confirmed conclusions

- Goal `active` 只是服务端生命周期观察，不等于有效工作进展。
- Ralph 需要 polling reconciliation 和 meaningful-progress/stall evidence。
- token/time 增长不能单独阻止 stalled 判断。

## Rejected assumptions

- terminal notification loss 未被本次 incident 证实。
- native file picker 未被本次 incident 证实为根因。
- 不能把 liveness 问题归咎于用户观察到的 UI 位置。

## Architecture decisions

- polling 默认 30 秒，stall 默认 15 分钟，24 小时只作为 absolute hard cap。
- transport disconnect 只允许重连同一 thread；禁止静默启动第二个 Goal。
- `close()` 与显式 pause 分离。

## Known open risks

- CLI 信号处理尚未自动执行 pause-and-confirm。
- 真实 Payroll UAT 尚未重新验证。

## Next recommended action

把 controlled shutdown helper 接入正式控制器的 intentional-stop 路径，然后用受控真实任务验证。
