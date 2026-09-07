# 排查报告：微信会话重复回复 / 占位符刷屏 / 中断

> 排查时间：2026-09-03 14:xx
> 目标会话：`agent:main:openclaw-weixin:direct:o9cq805xnizc9sgxep9w29tqnyba@im.wechat`
> 数据源：`~/.openclaw/agents/main/agent/openclaw-agent.sqlite` + `~/Library/Logs/openclaw/gateway.log`
> 现象：assistant 反复输出无意义占位符 `count。`/`countshares。`/`call。`/"Count no more."/"I'll list..."，用户多次追问仍复读，且回复偶发中断。

---

## 一、直接结论（回答用户三个问题）

1. **「重复回复 count」不是系统 prompt 导致的。**
   系统提示词（agent main 定义、`AGENTS.md` 9.4KB、`CLAUDE.md` 429B）里**没有任何 "count。/countshares。/Count no more."** 这类内容，也查无 "不要输出 count" 之类的对抗指令。这些占位符**全部是模型在长上下文末端的自退化输出**，被完整、真实地写进了 transcript（每条 assistant 消息的 `usage.output` 都记录了这些 token）。

2. **「是不是思考模式被关闭了」——方向对了一半。**
   `deepseek/deepseek-v4-flash` 在 `openclaw.json` 里配置为 **`reasoning = False`**（无独立思考/CoT 通道）。这使模型没有「先内部推理、再输出正文」的分隔，**任何退化/续写行为会直接以正文文本形式泄漏出来**。若开 reasoning，占位符大概率会被关进思考通道、不污染对外回复。但**根因不是关思考**，而是下面的上下文膨胀。

3. **「还总中断」** —— 主要是**同一轮 tool 循环内多次独立请求**之间间隔过长 + 长上下文每次请求耗时长（实测单次 1.7~4s），叠加微信端无增量响应，体感像「卡住/中断」。不是投递层失败（`conversation_deliveries` 今日无记录，消息均正常送达并得到用户继续追问）。

---

## 二、证据链（时间线还原）

### 占位符起点：今天 09:00 前后写「中文数字口语化模块」
- `seq=1620~1660`：agent 在给播报系统写 **cnInt/cnPrice（数字→中文口语）转换**，代码全文高频出现 `shares`/`price`/`count`/`this.shares`。
- 此时上下文 `cacheRead` 已达 **55.2 万 token**（seq 1620）→ 55.5 万（1634）。
- `seq=1634` 起，assistant 正文里**首次密集出现 `count`/`countshares` 占位符**——模型把代码里高频 token 当成续写占位。

### 占位符刷屏：seq=1634 → seq=1727（最后一轮）
- 覆盖今天 09:00~14:03，共 20+ 条 assistant 消息带占位符。
- 用户多次质询（"你为啥回复成 count。" seq1681、"Count no more." seq1685、"你又在输出count了" seq1716、"为啥不回复了" seq1724）。
- agent 自己也承认："我产生了大量无意义的 count。/countshares。输出，这是错误的"（seq1682）、"疯狂输出...填充垃圾"（seq1686）。

### 模型层证据（无截断、无重试失败）
- gateway 日志：这些请求全部 `provider=deepseek model=deepseek-v4-flash status=200`，单次 1.7~4.0s，`stopReason=stop` 或 `toolUse` **正常结束**。
- **没有 max_tokens 截断、没有 provider 超时、没有网络中断**。占位符是模型真实输出，不是截断残留。

---

## 三、根因（三层叠加）

| 层级 | 事实 | 后果 |
|---|---|---|
| **上下文过度膨胀** | 同一会话从 09-01 09:17 单窗口活到 09-03 14:03，**1728 条事件无压缩/无分裂**；到 09-03 14:00 `cacheRead` 高达 **59.9 万 token**（逼近 deepseek-v4-flash 的 1M context 60%） | 注意力稀释，模型末端退化复读 |
| **tool 循环长且失败多** | 09:00~10:00 一段 + 13:34~14:03 一段，agent 反复 `exec` 改脚本→失败→重试，tool result 大量堆积（含截断的 64 条/次） | 历史里塞满重复失败噪音 |
| **模型 reasoning=False** | v4-flash 无思考通道 | 退化 token 直接以正文泄漏成 `count。` 刷屏，无缓冲 |

**compaction 配置未生效**：`agents.defaults.compaction = { mode: safeguard, maxActiveTranscriptBytes: 15mb, keepRecentTokens… }`，但该会话实际**只有一个 window、reason=None、从未触发压缩**——60 万 token 全程单窗堆叠。这是能通过配置直接改善的第一切入点。

---

## 四、建议处置（按优先级）

### 短期（止血，可立即做）
1. **开新会话 / 清空该会话上下文**（或让 agent 手动 `/clear`）。60 万 token 上下文已不可救，占位符会持续。→ 立竿见影。
2. 若必须保留，触发一次 compaction 压缩到近几轮。

### 中期（结构性，推荐）
3. **该会话改用带思考的模型**（`deepseek/deepseek-v4-pro`，reasoning=True，或 `xiaomi-coding/mimo-v2.5`），至少占位符会被关进思考通道，不再污染正文。改 agent 模型时微信会话若想局部切，可在会话内切模型。
4. **收紧 compaction**：把 `maxActiveTranscriptBytes` 调小（如 15mb→ 4~6mb）并确认 `mode` 能从 safeguard 真正触发窗口分裂；或手动为长任务开新 session 而非堆在同一窗。
5. **减少 tool 噪音**：脚本调试类任务避免在同一上下文内长时间 `exec` 失败重试——每轮失败后应读一次文件修正，而非靠多次重复执行。

### 长期（防再发）
6. 检查 `tool-result-truncation`（曾见 `Truncated 64 tool result(s)`），确认超大 tool result 不会被整段塞进 prompt history 拖垮注意力。

---

## 五、涉及的关键位置速查
- 会话库：`~/.openclaw/agents/main/agent/openclaw-agent.sqlite`（表 `transcript_events`/`session_windows`/`conversations`）
- 模型配置：`~/.openclaw/openclaw.json` → `agents.defaults.model.primary = deepseek/deepseek-v4-flash`（reasoning=False）、`compaction.mode=safeguard`
- 运行时日志：`~/Library/Logs/openclaw/gateway.log`
- 同一微信用户实际对应 3 个 bot account（`bc7e5c63cc4c-im-bot`/`872bd968de0a-im-bot`/`default`），本会话属于 `bc7e5c63cc4c-im-bot`（primary session 07d98304）。
