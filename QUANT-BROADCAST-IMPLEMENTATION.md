# StackChan × OpenClaw × 量化播报 — 实施报告

> 日期：2026-09-02 ｜ 环境：Mac (Intel x64) / Node 24 / Python 3.14 ｜ 机器人：M5Stack CoreS3 (K151)
> 目标：在 xiaozhi-esp32 体系固件上实现「量化系统主动推送 → 机器人开口说话 + 换表情」最小闭环，并作为 OpenClaw 的语音渠道。

---

## 0. 结论速览

**实现路径选型：方案 (a) 复用 ai-server 已有接口 + 小改（已实施并验证通过）。**

| 状态 | 内容 |
|------|------|
| ✅ 已跑通（无硬件模拟验证） | 量化事件 → `/internal/say` → 机器人说话 + 表情 + LED 全链路 |
| ✅ 已跑通 | ai-server 启动、设备 WS 握手协议、TTS 中文合成（修复了 tts_server.py 中文 bug） |
| ✅ 已跑通 | 量化播报脚本对接真实 `stock-portfolio-app`（读到 16 笔真实订单，基线 + 增量两轮验证） |
| ⏳ 待做（需真机） | 固件烧录、真机 Wi-Fi 配网、唤醒词模型、真机语音对话联调 |
| ⏳ 待做 | OpenClaw Gateway 侧确认 agent id / API key，跑通「对话 + followup」双通道 |
| ⚠️ 风险 | 本机无 ESP-IDF 与固件源码；v0.1 固件唤醒词模型缺失；8766 控制口无鉴权 |

**代码改动量：约 150 行（session.ts / device_control.ts / tts_server.py），零固件改动，无需重编 ESP32。**

---

## 1. 研究结论

### 1.1 这个 fork 是什么

`whq731/StackChan-OpenClaw-Hermes`（上游 styles01）**不含固件源码**，它是围绕固件的"桥接层"项目：

- `ai-server/` —— TypeScript 桥（核心，~4000 行）：设备(WS+Opus) ↔ OpenClaw Gateway(18789) / HermesAgent
- `releases/v0.1/` —— **预编译固件**（官方 M5Stack StackChan v1.4.3 = xiaozhi-esp32 v2.2.4 fork，ESP-IDF v5.5.4 编译，CoreS3 已验证可跑）
- `FLASHING-GUIDE.md` —— 烧录避坑指南（血泪经验：otadata CRC、备份校验、DIO 模式）
- `test-harness/web-config.html` —— 浏览器直连机器人 `/config` 端点配网，无需重烧
- `tools/wake_word_flasher.py` —— 自定义唤醒词模型烧录工具

### 1.2 ai-server 接口契约（关键发现）

| 项 | 值 |
|----|----|
| 设备 WS | `ws://<host>.local:8765/ws`（mDNS 发现），握手头 `Device-Id: <MAC>` |
| 设备 hello | `{type:"hello", version:3}` → 回 `{type:"hello", session_id, audio_params:{24000Hz, 60ms}}` |
| 控制口 | `http://127.0.0.1:8766`（仅本机），原有 `GET /internal/status`、`POST /internal/followup`、`POST /tools/call` |
| OpenClaw 对接 | 纯 HTTP `POST /v1/chat/completions`，头 `Authorization: Bearer <key>` + `x-openclaw-session-key: agent:<agent_id>:stackchan:<device_id>`，body `model: openclaw/<agent_id>` |
| 设备绑定 | `ai-server/devices.json`：`default → {backend:"openclaw", agent_id:"rosie"}`，可按 MAC 覆盖 |
| 下行协议 | 说话=`{type:"tts",state:start/sentence_start/stop}` + Opus 二进制帧；**表情=`{type:"llm", emotion}`**，8 种：neutral/happy/laughing/angry/sad/crying/sleepy/doubtful；摇头/LED/拍照=MCP `tools/call` |
| TTS | `STACKCHAN_LOCAL_TTS_URL` 指向本地 edge-tts 服务（`tools/tts_server.py`，POST 文本→24kHz WAV） |

**决定性发现**：8766 控制口已有 `POST /internal/followup`（外部提交 prompt → LLM → TTS → 机器人开口），即"主动推送"机制现成存在。缺的只是两个小能力：①不经过 LLM 直接播报精确文本；②显式指定表情。这就是为什么选方案 (a)。

### 1.3 为什么不选 b / c

- **(b) 改固件加 HTTP 播报端点**：需要装 ESP-IDF v5.5.4 + 改 xiaozhi 源码重编。CoreS3 上 TTS/Opus 编码全在云端侧（ai-server），固件侧加 HTTP 端点后仍要走一遍"合成→下发"的同样链路，等于把 ai-server 的活儿在固件里再做一遍，收益为零、风险（变砖/调试周期）高。
- **(c) OpenClaw channel 插件推消息**：OpenClaw 主动外呼需要 channel 插件（research/ 目录已论证 WS 协议对 ESP32 太重、v2 channel plugin 属未来项）。且量化事件源在 `stock-portfolio-app` 而非 OpenClaw，让量化系统 → OpenClaw → 插件 → 机器人绕两跳，反而增加故障点。
- **(a) 胜出理由**：数据源（量化系统）和发声器官（ai-server 8766）在同一台 Mac 上，一个 HTTP POST 直达；表情走固件原生支持的 `llm.emotion` 字段；后续若要"让机器人复述并评论"，`/internal/followup`（走 LLM）也现成。

---

## 2. 已实施的改动（全部完成）

| 文件 | 改动 |
|------|------|
| `ai-server/src/session.ts` | 新增 `enqueueSay(text, emotion)` / `drainSayQueue()` / `processSay()`：与 followup 同款的排队串行播报——不经过 LLM，直接分句 → TTS → Opus 下发；表情经标准 `{type:"llm", emotion}` 下发；说话期间 state=processing（天然与语音对话互斥）；`close()` 清空队列；followup/say 结束互相触发排水 |
| `ai-server/src/device_control.ts` | 新增 `StackChanSayEmotion` 类型与 `POST /internal/say` 路由：body `{"text":"...", "emotion":"happy"}`，text 截断 2000 字，emotion 白名单校验，设备未连接返回 503 |
| `ai-server/tools/tts_server.py` | **修复 bug**：`is_mostly_ascii()` 原来恒返回 `True`，导致中文永远用英文音色，edge-tts 合成返回空音频（HTTP 500）。现按 CJK 字符检测选音色 |
| `ai-server/scripts/quant_broadcaster.mjs` | **新增**：轮询 `stock-portfolio-app` 的 `/api/real-quant/orders`，检测新订单/状态变化（filled/cancelled/…），生成中文播报文本（买入=happy、卖出/止损=sad、待确认=提示确认），POST 到 `/internal/say`。首轮静默记录基线不播报历史；状态文件去重防重启重放；失败自动回滚下轮重试 |
| `ai-server/scripts/fake_device.mjs` | **新增**：无硬件验证用模拟设备（连 WS、发 hello、打印下行消息、统计 Opus 帧） |
| `ai-server/.env.example` | 追加 `/internal/say` 与播报脚本的环境变量文档 |
| `ai-server/.env` | **新建**（本机配置，见 §4） |
| `ai-server/.venv/` | 新建 Python venv 并安装 `edge-tts`（系统 Python 有 PEP 668 限制） |

**质量验证**：`tsc --noEmit` 零错误。

## 3. 端到端验证结果（无硬件，2026-09-02 实测）

启动三件套后（TTS 服务 → ai-server → 模拟设备），两次实测：

**测试 1（直接推送）**：`POST /internal/say {"text":"交易提醒：贵州茅台 600519 买入信号，参考价 1520.50，200 股。","emotion":"happy"}`
模拟设备实际收到：`llm emotion:happy` → `tts start` → `sentence_start`（文本原样）→ **150+ Opus 帧（60ms/帧）** → `sentence_end` → `tts stop`，全程 LED 经 MCP 同步变色。✅

**测试 2（量化系统真实数据）**：`stock-portfolio-app` 在 3001 端口存活，播报脚本首轮静默记录 16 笔历史订单基线 ✅；删除基线中 #67 模拟新订单，重启后精确播报一条——

> 「交易提醒：中远海控 卖出委托已提交（止损-3%），价格 16.54，1400 股。」（emotion: sad）✅

## 4. 可执行实施步骤（照做即可）

### 步骤 1：环境准备 ✅（本机已完成）

```bash
cd ~/projects/StackChan-OpenClaw-Hermes/ai-server
npm install                          # 已完成（修复过 opusscript 缺 build 产物，重装即好）
python3 -m venv .venv && .venv/bin/pip install edge-tts   # 已完成
# ffmpeg 已在 ~/bin/ffmpeg（TTS 的 MP3→WAV 转码依赖）
```

`.env` 已建好，关键字段（连真机时按需改）：

```ini
STACKCHAN_BACKEND=openclaw
OPENCLAW_HOST=127.0.0.1      # Gateway 同机；跨机改 IP
OPENCLAW_PORT=18789
OPENCLAW_AGENT_ID=rosie      # ← 改成你的 agent id
OPENCLAW_MODEL=openclaw/rosie
OPENCLAW_API_KEY=            # ← 填 Gateway 密码
STACKCHAN_DEVICE_ID=stackchan-cores3
STACKCHAN_WS_HOST=0.0.0.0    # 允许机器人从 Wi-Fi 连入
STACKCHAN_LOCAL_TTS_URL=http://127.0.0.1:18002/?language=zh
STACKCHAN_TTS_SEGMENT_MAX_CHARS=60
```

### 步骤 2：固件烧录（需真机，30 分钟）

优先用 `releases/v0.1/` 预编译包（免装 ESP-IDF）：

```bash
PORT=/dev/cu.usbmodemXXXX   # ls /dev/cu.usbmodem* 查询
ESPTOOL=pip3 所在环境的 esptool.py

# 先按 FLASHING-GUIDE.md 备份并校验（0x10000 处须有 0xE9 magic）！
$ESPTOOL --chip esp32s3 -p $PORT -b 460800 --before=default_reset --after=hard_reset \
  write_flash --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x0     releases/v0.1/bootloader.bin \
  0x8000  releases/v0.1/partition-table.bin \
  0xd000  releases/v0.1/ota_data_initial.bin \
  0x20000 releases/v0.1/stack-chan.bin
```

烧录后：机器人开热点/连网 → 浏览器打开 `test-harness/web-config.html` → 填机器人 IP 与 `ws://<Mac的hostname>.local:8765/ws` → 无需重烧即可改配置。

> 要自编译固件才需要 ESP-IDF v5.5.4（本机尚未安装）：`git clone -b v5.5.4 https://github.com/espressif/esp-idf` + `./install.sh`，然后 `idf.py set-target esp32s3 && python3 fetch_repos.py && idf.py build flash`（约 2 分钟编译）。

### 步骤 3：服务启动（本机，已验证）

```bash
# 终端 1：TTS（中文音色）
cd ai-server && TTS_VOICE=zh-CN-XiaoxiaoNeural .venv/bin/python tools/tts_server.py   # :18002

# 终端 2：ai-server（设备 WS :8765 + 控制口 :8766）
cd ai-server && ./node_modules/.bin/tsx src/index.ts
# 或 npm run build && npm start（dist 方式）

# 终端 3：量化播报
node scripts/quant_broadcaster.mjs
```

手动测试一条：`curl -X POST http://127.0.0.1:8766/internal/say -H 'content-type: application/json' -d '{"text":"收盘了，今日复盘已生成。","emotion":"neutral"}'`

### 步骤 4：量化播报联调（真机到场即生效）

播报脚本已在真实量化系统上验证过数据面；真机连上 ai-server 后，盘中 RealQuantScan（5min/次）产生的 buy/sell 订单及状态流转（sent→filled 等）会自动开口播报。扩展点：`quant_broadcaster.mjs` 目前只盯订单表，可按同一模式加 `/api/real-quant/review`（复盘）、持仓变化、成交回报（filled 播报已支持）。

### 步骤 5：OpenClaw 对接

- **语音对话（唤醒词 → 对话）**：固件原生支持；说话走 `OPENCLAW_HOST:18789/v1/chat/completions`，session key `agent:<agent_id>:stackchan:<device_id>`（已验证过 4am 重置后 channel 身份存活的机制）。只需在 `.env` 填对 agent id 与 API key。
- **OpenClaw 主动推送**：现成 `POST :8766/internal/followup {"prompt":"..."}` —— 让 OpenClaw/agent 调它，机器人会走 LLM 生成口语化回复并说出（适合"问它今天持仓怎么样"）。
- **传感器/控制回传**：13 个 MCP 工具（`POST :8766/tools/call`，如 `stackchan_take_photo`/`set_head_angles`/`set_led_color`）；触摸/IMU 事件回传给 OpenClaw 目前**未实现**（见 §6 待做）。

---

## 5. 成本与现成度清单

| 环节 | 现成度 | 成本 |
|------|--------|------|
| 固件 | ✅ 用 v0.1 预编译包 | 30 分钟烧录，0 改动 |
| ai-server 播报能力 | ✅ 本次已补齐（/internal/say） | 已完成（~80 行） |
| TTS 中文 | ✅ 已修复可用的 edge-tts 本地服务 | 已完成（免费，依赖微软网络可达） |
| 量化事件 → 播报 | ✅ 已完成并验证（~180 行脚本） | 已完成 |
| OpenClaw 对话 | ✅ ai-server 原生支持 | 仅需填 agent id / key |
| 唤醒词 | ⚠️ v0.1 禁用了内置词，需烧一个模型 | 见风险 R2 |
| 触摸/IMU 事件回传 OpenClaw | ❌ 未实现 | 中等（固件侧事件上报为空缺） |

## 6. 待做与风险（诚实清单）

- **R1｜本机无固件源码/ESP-IDF**：日常用预编译包即可；若将来要改固件（如加传感器上报），需先装 ESP-IDF v5.5.4（约 5GB 磁盘 + 30 分钟）。
- **R2｜唤醒词模型**：v0.1 固件禁用了内置 "Hi Stack Chan"，模型分区（0xE00000）需另烧——原作者的 "Hey Agent A" 模型对我们无意义。短期可从 xiaozhi-esp32 仓库提取官方 WakeNet 模型（如 "Hi ESP"）用 `tools/wake_word_flasher.py` 烧入；长期可训练自己的唤醒词（需 GPU/DGX 或 Espressif 定制申请）。
- **R3｜8766 控制口无鉴权**：只绑 127.0.0.1 所以同机安全；若量化系统与 ai-server 分机部署，须改 `STACKCHAN_CONTROL_HOST=0.0.0.0` 并自行加 token（当前代码无校验，不建议跨机裸奔）。
- **R4｜TTS 依赖微软 edge-tts 公网**：国内网络偶发超时（实测首启一次 60s 超时，之后稳定）。备选：换 `zh` 本地 TTS（如 CosyVoice/GPT-SoVITS），`STACKCHAN_LOCAL_TTS_URL` 指过去即可，协议兼容（POST 文本 → WAV）。
- **R5｜单设备**：ai-server 只维护一个 activeSession，多台机器人需按 Device-Id 路由（代码里 TODO，单机器人无影响）。
- **R6｜表情能力边界**：表情由固件端 8 种映射决定（走 xiaozhi 原生 emotion），无法自定义表情图；如需更丰富表情要改固件渲染层。
- **R7｜QMT semi 模式**：`pending_confirm` 订单播报只做提醒，确认仍需到持仓系统手动执行（与现风控一致，不自动化）。

## 7. 与既有 stackchan-bridge（官方固件 MOD）的关系

`~/.openclaw/workspace/stackchan-bridge/` 是基于 stack-chan 官方 Arduino 固件的 HTTP 播报 MOD，与 xiaozhi 体系**不兼容**，不迁移。本方案在新体系上重建了等价能力（`/internal/say` ≈ 旧 `/speech` 端点），旧桥可弃用。
