# 给 ESP32 语音机器人接本地大模型网关：绕开厂商云的分层复盘

> 设备 M5Stack CoreS3 · 客户端固件 xiaozhi-esp32 v2.2.4 · 中继自研 TS 桥 · 网关 openclaw 本地实例

把一个联网就自动连厂商云的 ESP32 语音积木，改成**只连你本地的模型网关**。跑通后最深的体会：瓶颈根本不在"音质"或"模型多强"，而在你能不能干净地接管三段——**引导握手、协议适配、网关鉴权**。三层各一把钥匙，各自的坑如下。

---

## 设备层：别想蓝牙，音频走 WiFi

直觉误区：让机器人出声 = 配对蓝牙 A2DP。但固件**只开了 BLE（NimBLE），没有经典蓝牙 A2DP**，而音频本身就是走 WiFi 语音链路，落不到蓝牙。
外放的正确做法是在中继/系统层另开一路（我们最终让 Mac 把 TTS 播到系统默认输出），不是指望机器人自己蓝牙。

> 看 sdkconfig.defaults，`BT_NIMBLE_ENABLED=y` 不代表能当 A2DP 音源。BLE ≠ 经典蓝牙。

## 中继层：为什么自研 TS 桥，不直接用现成 Python 服务

官方有 10k+ star 的 Python 后端（xiaozhi-esp32-server），看着省事，但**接自建模型网关它反而添乱**：其 LLM 适配器只带 api_key、不带自定义 header——而 openclaw 这类网关恰恰必须背私有 header（`x-openclaw-session-key`）+ 特殊 model 名（`openclaw/<agent_id>`）。用它反而要中间插反代去注入 header。

自研桥的取舍一句话：**协议（WS + Opus 帧）是标准就复用，策略（接谁、怎么接）是私有的自己写**。后端差异收敛成"header 名 + model 命名"两个字段，profile 化，这就是分层解耦的落地样子。

## 网关层：两个"以为对了其实没对"

- **原生依赖是平台陷阱**：本地跑 Silero VAD（MIT，本地 ONNX 推理）时，`onnxruntime-node` 高版本把 darwin/x64 原生库删了（Intel i7）。直接装最新跑不起来，**钉死 1.20.1** 反而稳定。教训：TS/Node 接本地推理，先查你这平台 + CPU 架构在这个版本有没有原生二进制。
- **SSE 只读 `delta.content`，于是模型把思维链念了出来**：换 deepseek-v4-flash 后机器人会把自己的思考当回答播报（日志里出现"让我把音量调到最大…已调到最大 📢"这种自语）。根因是架构约定没对齐——网关里标 `reasoning:false`，但**对 deepseek-v4-flash 不等于真的下发 `thinking:{type:"disabled"}`**，复杂任务里推理仍内联进 content，你没法按独立字段剥掉。

## 绕开厂商云那把最关键的钥匙：OTA 引导握手

上面都是"内部"的坑，真正决定"设备连谁"的是开机那次握手：

xiaozhi-esp32 每次开机 POST 一个 OTA URL，响应直接定生死——带 `mqtt` 就连官方云，带 `websocket` 才连你本地。官方烧录器会**全片擦写清掉 NVS 里的 URL**，设备退回固件编译死的官方地址 → 连不上本地。

解法：**在自建服务里内置一个 OTA 应答端点**，同时把固件默认 URL 重编指到本地，返回：

```jsonc
{ "websocket": { "url": "ws://<Host头>:8765/ws", "version": 3 } }
```

三个硬性细节：
1. **只给 websocket、不给 mqtt 和 firmware 段**，否则设备可能去连云或尝试固件升级；
2. `url` 复用请求 Host 头（保证设备可达），IP 变了用 env 覆盖——**别写死 IP**，否则 Mac 换 IP 就得重编；
3. **`version` 必须 = 3**，匹配服务端 Session.version；固件默认是 1，不靠 OTA 升到 3 握手不认。

---

一句话收束：**消费级语音硬件能不能"自己说了算"，取决于能不能干净接管"引导握手 + 协议适配 + 网关鉴权"这三段**。跑通后剩下的（换模型、调 VAD、修长句播放）就都是普通体力活了。

---

### 版本号速查（复现友好）

| 组件 | 版本 / 关键点 |
|---|---|
| 固件 | M5Stack StackChan，内嵌 xiaozhi-esp32 v2.2.4 |
| 客户端协议 | WS：hello/listen/abort/mcp；音频 Opus，BinaryProtocol v2/v3 |
| 采样率 | 上行 16 kHz / 下行 24 kHz |
| 引导握手 | POST OTA → `{"websocket":{url,version:3}}`（无 mqtt/firmware） |
| 网关 | openclaw 本地实例，Bearer token + `x-openclaw-session-key` |
| VAD | Silero ONNX v5.1.2 tag；`onnxruntime-node` 钉 1.20.1（1.29 删 darwin/x64 原生库） |
| 外放 | `/usr/bin/afplay` 播系统默认输出（Mac） |
