# StackChan 瓦力播报工具使用指南（给龙虾/OpenClaw Agent）

> 目标读者：OpenClaw main agent（龙虾）。你已经接好了一个叫 `stackchan` 的 MCP server，
> 可以让桌面机器人瓦力（M5Stack CoreS3）开口说话、做表情、转头、拍照。
> 本文档告诉你有哪些工具、什么时候用哪个、出错怎么降级。

## 快速认知

瓦力的链路是：你（OpenClaw agent）→ MCP 工具 → ai-server（Mac 上 127.0.0.1:8766）→ 瓦力。
**播报能否送达取决于设备是否连线**（WS 会话存在）。设备待机（不监听）时播报依然可达，
且播完自动保持待机；只有设备完全离线（关机/断网/崩溃重启中）才会失败。

工具调用失败时会返回 `isError: true` + 可读错误文本，不要重试超过 1 次，直接放弃本轮播报并记录即可。

## 工具清单

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `stackchan_say` | 让瓦力照念一段文本（自动分句、本地 TTS） | `text`（必填，≤800字），`emotion`（可选表情） |
| `stackchan_followup` | 投递一条 prompt，瓦力经过 LLM 思考后自己组织语言说 | `prompt`（必填，≤12000字） |
| `stackchan_get_status` | 查询连接状态、状态机、队列 | 无 |
| `stackchan_get_head_angles` | 读头部 yaw/pitch | 无 |
| `stackchan_set_head_angles` | 转头 | `yaw`、`pitch`（度） |
| `stackchan_set_led_color` | 底部 RGB 灯 | `r` `g` `b`（0-255） |
| `stackchan_set_speaker_volume` | 音量 | `volume`（0-100） |
| `stackchan_take_photo` | 拍照（CoreS3 摄像头） | 无 |

`emotion` 可选值：`neutral, happy, laughing, angry, sad, crying, sleepy, doubtful`。

## 播报任务怎么选工具

- **数据播报**（行情快照、定时提醒、固定话术）→ 用 `stackchan_say`。文本自己组织好，控制在 200 字以内效果最好（太长分句多、播得久）。
- **需要瓦力"用自己的话说"**（总结、评论、闲聊式提醒）→ 用 `stackchan_followup`，prompt 里写清楚背景和要它说什么。注意 followup 走 LLM 有几秒延迟，且依赖 OpenClaw 链路正常。
- **下单/止损/止盈等交易事件播报** → 用 `stackchan_say` + 明确文本（如"注意，BTC 触发止损，亏损 2.3%"），不要用 followup（避免 LLM 改写关键数字）。
- 数字建议写成中文读法（"涨幅百分之三" 比 "+3%" 读出来更自然）。

## 标准调用流程

1. （可选但推荐）先调 `stackchan_get_status`，确认 `connected: true`。
2. 调 `stackchan_say` 或 `stackchan_followup` 播报。
3. 返回 `{"spoken": true}` / `{"queued": true}` 即成功，无需确认。

失败降级：`isError` 返回含 `unreachable`（ai-server 没跑）或 `HTTP 4xx/5xx`（设备不在线）时，
跳过本次播报，不要反复重试。量化任务里宁可漏一条播报，不要阻塞交易逻辑。

## 当前系统状态（2026-09-02）

- ai-server：Mac 上常驻运行（8765 设备 WS / 8766 控制 HTTP），启动命令
  `cd ~/projects/StackChan-OpenClaw-Hermes/ai-server && ./node_modules/.bin/tsx src/index.ts`
- STT：Groq whisper-large-v3（云端，走 Clash 美国节点规则），本地 faster-whisper 兜底
- TTS：本地 edge-tts :18002（中文），带自动重试
- 待机词：「睡觉 / 睡吧 / 休息 / 安静」；唤醒词：「Hi Walle」（注意：待机中唤醒恢复暂未生效，见 TODO）
- 已知问题：设备偶发崩溃重启（tcp_receive，观察中）；设备完全离线时播报失败属正常

## FAQ

**Q: say 返回成功但瓦力没声音？** 先查 `stackchan_get_status`；若 TTS 偶发失败会自动重试 2 次，
仍失败会报 isError。偶发一次失败属正常，下次调用即恢复。

**Q: 瓦力屏幕上显示的内容？** 播报期间瓦力会显示说话表情，播完回到之前状态。

**Q: 能同时排队多条播报吗？** 可以，ai-server 内部有队列，按顺序播。
