<div align="center">

<img src="docs/cover-dark.png" alt="Stack-chan × OpenClaw × Hermes" width="512">

# Stack-chan × OpenClaw × Hermes

**给一台小机器人接上真正的 AI Agent —— 支持持久身份、工作区访问、会话控制，以及跨后端的多 Agent 绑定。**

[![Version: 0.1](https://img.shields.io/badge/version-0.1-blue.svg)]()
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform: ESP32](https://img.shields.io/badge/platform-ESP32-blue.svg)](https://www.espressif.com/en/products/socs/esp32)
[![Agent: OpenClaw](https://img.shields.io/badge/agent-OpenClaw-purple.svg)](https://docs.openclaw.ai)
[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/aitamedia)

**简体中文** | [English](README.md)

[项目背景](#问题所在) · [架构](#架构) · [固件](#固件) · [配置编辑器](#web-配置编辑器) · [测试](#测试套件) · [调研](#调研)

</div>

---

## 问题所在

你有一台 [Stack-chan](https://github.com/meganetaaan/stack-chan) —— 一台有脸、有喇叭、有麦克风的小 ESP32 机器人。开箱即用的状态下，它和所有其他 IoT 设备一样跟云端 LLM API 通信：无状态 HTTP 调用、没有身份、没有记忆、没有 Agent 绑定。每次请求都是一次性交易。机器人不知道自己是谁、在和谁说话、五分钟前聊过什么。

这不是 AI 伙伴，这只是个长了脸的智能音箱。

## 立项初衷

**如果机器人是 AI Agent 生态里的一等公民，并且能绑定到不同后端上的不同 Agent，会怎样？**

我们运行着两个 AI Agent 平台：

- **[OpenClaw](https://docs.openclaw.ai)** —— 运行带工作区访问、记忆文件和工具调用的 Agent。Agent 通过通道（Telegram、Discord、WhatsApp）与人对话，每个通道拥有**稳定身份**，能在会话重置、dreaming 周期和上下文压缩后依然存活。
- **[Hermes](https://github.com/NousResearch/hermes-agent)** —— 运行带 STT、LLM、TTS、记忆、技能和 MCP 配置的 Agent。

**目标：** 让 Stack-chan 在**两个**生态中都成为正式通道 —— 并且通过 profile 绑定，让每台实体机器人知道自己属于哪个后端、哪个 Agent。

### Profile 绑定

每台 Stack-chan 都有一个 **profile**，把它绑定到特定的后端 + Agent：

| 机器人 | 后端 | Agent | 端口 | 会话 Key |
|-------|---------|-------|------|------------|
| Robot A | OpenClaw | Agent A（家庭事务） | 18789 | `agent:agent-a:stackchan:robot-a` |
| Robot B | Hermes | Agent B（产品战略） | 8643 | `agent-b-stackchan:robot-b` |
| Robot C | OpenClaw | 自定义 Agent | 18789 | `agent:custom:stackchan:robot-c` |

Profile 通过 BLE 配网或 Web 配置编辑器设置，**无需重新烧录**。配置中的 `backend` 字段选择 OpenClaw（0）或 Hermes（1），后续的 Agent 绑定 header 和路由随之切换。

### 为什么要两个后端？

OpenClaw 和 Hermes 各有所长。OpenClaw 给 Agent 提供工作区文件读写、通道持久化和工具调用。Hermes 提供语音优先交互、MCP 工具和 TUI 面板。有的机器人当家庭助手（OpenClaw / Agent A），有的当研究伙伴（Hermes / Agent B）。Profile 绑定让一队机器人横跨两个世界。

## 环境要求

### 硬件

- **M5Stack CoreS3** —— ESP32-S3、16MB flash、ILI9342C 屏幕、双麦克风、扬声器
- USB-C 数据线（烧录用）
- WiFi 网络（2.4 GHz —— ESP32 不支持 5 GHz）

### 固件工具链

- **ESP-IDF v5.5.4**（不是 Arduino/PlatformIO —— 原因见[固件](#固件)一节）
- Python 3.9+
- `esptool.py`（不装 ESP-IDF 也能烧录）

#### 固件基线与协议版本

设备固件基于 **xiaozhi-esp32 v2.2.4** 客户端协议栈构建。ai-server 直接说这个协议 —— WebSocket 上的控制消息（`hello`、`listen`、`abort`、`mcp`）加二进制 Opus 音频帧 —— 因此任何 xiaozhi 兼容的 ESP32-S3 固件都能用。已验证的构建目标：

| 项目 | 值 |
|------|-------|
| 板子 | **M5Stack CoreS3**（ESP32-S3，16 MB flash） |
| 芯片目标 | `esp32s3` |
| 框架 | ESP-IDF **v5.5.4** |
| 协议 | xiaozhi WS，**`version: 3`** |
| 音频 | Opus —— 16 kHz 进（麦克风）、24 kHz 出（扬声器） |

> ⚠️ **机器人是通过 OTA 找到服务器的，而不是配置文件。** 开机时固件 POST 到
> `CONFIG_OTA_URL` —— 这个地址是**编译进固件的** —— 然后连接应答里的
> `websocket.url`。构建前在 `sdkconfig.defaults` 里设置：
> ```c
> CONFIG_OTA_URL="http://<HOST_LAN_IP>:8765/ota"
> ```
> 主机 IP 变了就得改这里并重新构建 —— 否则机器人会一直敲一扇不存在的门，
> 永远连不上 ai-server。应答必须包含 `"websocket"`（绝不能是 `"mqtt"`，
> 否则设备会被引去厂商云）和 `version: 3`；这正是 ai-server 内置
> `POST /ota` 端点返回的内容。

> 💡 **强烈建议在路由器上给机器人和主机绑定静态 DHCP 租约。** 动态租约下，
> 路由器一重启设备 IP 就漂移，现象和"机器人掉线了"一模一样。

#### 双模式：本地 Agent 与官方云（设计如此）

固件有意支持**两种连接模式**并自动回落：

| 模式 | 触发条件 | 机器人连到哪 | 表现 |
|---|---|---|---|
| **本地**（默认） | 编译进固件的 OTA URL 可达（`POST /ota` 应答含 `websocket` 段） | 你的 ai-server → OpenClaw / Hermes | 你自己的 Agent：工作区访问、MCP 工具 |
| **官方云**（回落） | 开机时本地 OTA 不可达 | 小智官方云（`api.tenclass.net`，MQTT 配置持久化在 NVS） | 厂商云 AI —— 聊天、唱歌、讲故事 |

固件内部的实现机制：

- `ota.cc` 优先读 NVS 里的 OTA URL（`wifi.ota_url`），为空才用编译期 `CONFIG_OTA_URL`
- `application.cc InitializeProtocol()` 按 OTA 应答选协议：含 `mqtt` 段 → `MqttProtocol`；含 `websocket` 段 → `WebsocketProtocol`；**都没有 → 回落到 MQTT，endpoint 取自 NVS 持久化配置**
- NVS 里的 `mqtt`/`websocket` 条目由官方固件/官方激活流程写入，**有意保留** —— 它们是官方云回落能工作的前提

> 所以如果机器人突然唱歌、或说出你的 Agent 绝不会说的话 —— 那是官方云在接客，
> 不是你的 Agent。等 ai-server 恢复后再唤醒它，或者等下次开机/激活时它会自动
> 重新挂回本地服务器。

### ai-server（桥接层）

ai-server 是 ESP32 设备和 AI Agent 后端之间的 TypeScript 桥。你需要：

- **Node.js** 20+
- **npm** —— 安装依赖：`cd ai-server && npm install`
- **tsx** —— 直接运行 TypeScript：`npx tsx src/index.ts`
- 依赖：`ws`（WebSocket）、`opusscript`（Opus 编解码）、`dotenv`（配置）

### Agent 后端（二选一或全要）

- **OpenClaw** —— 在你的网络里运行 [OpenClaw Gateway](https://docs.openclaw.ai)（默认端口 18789）。需要 agent ID、bot token 和模型名。
- **Hermes** —— 在你的网络里运行 [HermesAgent](https://github.com/NousResearch/hermes-agent)。需要 Hermes Python 环境和 dashboard URL。

### 端到端模块清单

| 组件 | 是什么 | 位置 | 必需？ |
|-----------|-----------|------|----------|
| **固件** | ESP32 固件（C++，ESP-IDF） | `firmware/` | 是 —— 跑在设备上 |
| **ai-server** | TypeScript WebSocket 桥 | `ai-server/` | 是 —— 连接设备与 Agent |
| **Web 配置编辑器** | 浏览器配置 UI | `test-harness/web-config.html` | 可选 —— 通过 WiFi 配置设备 |
| **唤醒词烧录工具** | 烧录自定义唤醒词模型的 Python 工具 | `tools/wake_word_flasher.py` | 可选 —— 自定义唤醒词用 |
| **测试套件** | Python E2E + 单元测试 | `test-harness/` | 可选 —— 验证用 |
| **配置编辑器** | YAML 配置服务（Node.js） | `config-editor/` | 可选 —— 另一种配置 UI |
| **OpenClaw Gateway** | AI Agent 平台 | [docs.openclaw.ai](https://docs.openclaw.ai) | 后端二选一 |
| **HermesAgent** | AI Agent 平台 | [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 后端二选一 |

### 快速开始

```bash
# 1. 烧录固件（需要 ESP-IDF v5.5.4）
export IDF_PATH=<your-esp-idf-path>
. "$IDF_PATH/export.sh"
cd firmware
idf.py set-target esp32s3
python3 ./fetch_repos.py
idf.py -p /dev/cu.usbmodemXXXX flash

# 2. 启动 ai-server
cd ai-server && npm install
cp .env.example .env  # 填入你的配置
npx tsx src/index.ts

# 3. 配置机器人（浏览器操作，不用重烧）
# 用浏览器打开 test-harness/web-config.html
# 输入设备 IP，设置后端 + Agent 配置

# 4. 开始对话！
```

> 想要三个服务常驻后台（ai-server/OTA、TTS、STT），可以用 PM2：
> `cd ai-server && pm2 start ecosystem.config.js` —— 配置文件头注释里有
> venv、ffmpeg 路径、模型路径等全部踩坑记录。

---

## 我们做了什么

### 固件扩展

把 Stack-chan 的 ESP32 固件扩展为对接 OpenClaw Gateway，而不是直连裸 LLM API：

- **Agent 绑定** —— 配置结构体扩展了 `agent_id`、`bot_token`、`default_model`，让机器人知道自己属于哪个 Agent
- **后端选择器** —— 同一套配置结构，可在 OpenClaw（`backend: 0`）和 Hermes（`backend: 1`）之间切换
- **配置端点** —— `GET /config` 返回当前配置 JSON，`POST /config` 写入 SPIFFS。机器人可以在线重配置，不用重新烧录
- **YAML 缓冲区** —— 扩到 4096 字节，装下扩展后的配置
- **Emoji 过滤** —— `stripEmoji()` 移除 4 字节 emoji 和 3 字节符号，保证 TTS 兼容（机器人念不出 🎉）

```cpp
// 固件配置结构体（StackchanExConfig.h）
// 把 "agent-a" 换成你的 agent id
struct openclaw_s {
  String host;
  uint16_t port;
  String agent_id;      // 例如 "agent-a"
  String bot_token;     // Gateway 鉴权
  String default_model; // 例如 "openclaw/agent-a"
};
```

### Web 配置编辑器

给 Stack-chan 做的浏览器配置编辑器 —— 因为用 SD 卡刷 YAML 太折腾了：

- Node.js 服务，端口 5570
- 从局域网内任何设备编辑机器人配置
- 直接 POST 到机器人的 `/config` 端点
- 不用重烧录、不用换 SD 卡

### 测试套件

**E2E 测试 8/8 通过。工作区写入测试 5/5 通过。**

测试套件模拟完整的固件消息管线 —— 系统提示 + 用户消息数组 → Gateway → Agent 回复 → JSON 解析 —— 并验证 Stack-chan 能：

- ✅ 对话到正确的 Agent（你的 Agent，不是默认的）
- ✅ 读写 Agent 工作区里的文件
- ✅ 处理多轮对话
- ✅ 处理来自 SPIFFS 的系统提示
- ✅ 解析固件兼容格式的 JSON 回复
- ✅ 调用工具（工作区文件写入已在磁盘确认）
- ✅ 跨请求保持 Agent 身份

## 架构

Stack-chan 支持**两个后端** + profile 绑定。固件配置结构体同时含 OpenClaw 和 Hermes 字段，通过 `backend` 选择器（0=OpenClaw，1=Hermes）切换。同一台机器人可以通过 Web 配置编辑器或 BLE 配网重配置到任一后端 —— 无需重烧。

### OpenClaw 路径

```
ESP32 Stack-chan                    OpenClaw Gateway                    Your Agent
┌─────────────┐    POST /v1/chat    ┌──────────────┐    agent run     ┌─────────────┐
│ OpenClaw    │ ──────────────────▶ │ Gateway      │ ──────────────▶ │ your-agent  │
│ Client      │  model:openclaw/    │ :18789       │                 │ (workspace) │
│             │  your-agent         │              │  ◀────────────── │             │
│ TTS + Avatar│ ◀───────────────── │              │   response      │             │
└─────────────┘    JSON response    └──────────────┘                 └─────────────┘
```

- Header：`model: openclaw/<agent_id>`、`x-openclaw-session-key: agent:<agent_id>:stackchan:<device>`、`x-openclaw-message-channel: stackchan`
- 通过 `model` 字段 + Agent 前缀的会话 key 实现 Agent 绑定
- 完整的工作区文件读写
- 会话 key 在凌晨 4 点重置后存活（只有 sessionId 轮换）

### Hermes 路径

```
ESP32 Stack-chan                    ai-server (bridge)                 HermesAgent
┌─────────────┐    WebSocket + Opus  ┌──────────────┐  session.create ┌─────────────┐
│ Hermes      │ ──────────────────▶ │ ai-server    │ ──────────────▶│ HermesAgent │
│ Client      │  ws://server:8765   │ (TypeScript) │  prompt.submit  │ (STT/LLM/   │
│             │                     │              │                 │  TTS/MCP)   │
│ TTS + Avatar│ ◀───────────────── │              │  ◀────────────── │             │
└─────────────┘  Opus audio stream  └──────────────┘  message.done   └─────────────┘
```

- 每个 profile 独立端口（Agent B 用 8643）
- 鉴权：`Authorization: Bearer <profile_api_key>`
- 会话：`X-Hermes-Session-Key: <agent>-stackchan-<device>`
- MCP 工具：`stackchan_take_photo`、`stackchan_set_head_angles`、`stackchan_set_led_color` 等
- 语音优先：流式 ASR + LLM + TTS 架构

### 参考实现：circlemouth/Hermes-StackChan

[Hermes-StackChan](https://github.com/circlemouth/Hermes-StackChan) fork 是 Hermes 路径的**主要参考**。它已经解决了：

- 固件 → 自建 WebSocket 服务器（替代 XiaoZhi 云）
- ai-server TypeScript 桥（Opus 音频 ↔ HermesAgent 协议）
- 完整 MCP 工具集（13 个机器人控制工具）
- 带 `websocket_url` 配置的 BLE 配网
- 桌面 UI 模拟器（不烧录也能测头像）
- 头像屏幕显示 Hermes 错误

我们在此基础上把 OpenClaw 扩展为第二个后端选项。

### 通道问题

> **为什么不直接用无状态 HTTP 客户端？** 因为 OpenClaw 每天凌晨 4 点重置会话 —— 为了防止上下文膨胀和启用 dreaming，会话上下文会被清空。但**通道身份存活**。重置后的下一条消息会在同一通道下创建全新会话。Stack-chan 需要同样的待遇。

OpenClaw 通道（Telegram、Discord、WhatsApp）拥有**稳定身份**，能在凌晨 4 点的会话重置 / dreaming 周期中存活。会话是临时的 —— 每晚清空以防止上下文膨胀。通道是永久的 —— 重置后的下一条消息在同一通道下创建新会话。

**Stack-chan 需要同样的待遇。** 两种方案：

| | v1: HTTP + Header | v2: 通道插件 |
|---|---|---|
| **方式** | 固件发送 `model: openclaw/<agent_id>` + `x-openclaw-message-channel: stackchan` + `x-openclaw-session-key: agent:<agent_id>:stackchan:<device>` | 一个最小化的 OpenClaw 通道插件，把 `stackchan` 注册为一等通道 |
| **Agent 绑定** | 通过 `model` 字段 + 显式会话 key 前缀 | 通过 `bindings` 配置（同 Telegram） |
| **会话持久化** | 会话 key 凌晨 4 点重置后存活（只有 sessionId 轮换，sessionKey 持久） | 相同 —— 通道插件构造规范的会话 key |
| **通道身份** | 合成的（header 标签，不是注册表里的真通道） | 一等公民（出现在 `channels list`，有配置，可挂多个账号） |
| **工作量** | 低 —— 今天就能用，Gateway 不用改 | 中 —— 插件代码 + manifest |
| **时机** | 现在就上线，先验证行为 | 当 Stack-chan 需要多设备、外发推送或通道管理时 |

### 关键结论

- **`model: openclaw/agent-a`** 能路由到目标 Agent 并获得完整工作区权限（读 + 写）✅
- **`user: "stackchan:<device_id>"`** 创建持久的 Agent 绑定会话 ✅
- **裸会话 key 会路由到错误的 Agent** —— `x-openclaw-session-key: stackchan:*` 会被重新归到默认 Agent。必须用 Agent 前缀的 key：`agent:<agent_id>:stackchan:*` ✅
- **凌晨 4 点重置轮换的是 `sessionId` 而非 `sessionKey`** —— 通道身份和会话 key 存活，只有对话上下文重置。这是设计使然（dreaming/压缩）✅
- **`x-openclaw-message-channel: stackchan`** 设置投递路由上下文（回复发往哪里），但不影响会话身份

## 固件

固件有**三条开发路径**。官方 M5Stack 固件用 ESP-IDF（不是 PlatformIO），社区也有 UIFlow2 Python 实现。

### 路径 1：官方 ESP-IDF 固件（✅ 已验证可用 —— 2026-08-18 构建 + 烧录）

官方 [m5stack/StackChan](https://github.com/m5stack/StackChan) 固件是**原生 ESP-IDF（C++）**，不是 Arduino/PlatformIO。它是 xiaozhi-esp32 v2.2.4 的 fork。固件版本：1.4.3。

**工具链：** ESP-IDF v5.5.4（装在 `<repo-root>/esp-idf/`）

```bash
# 激活 ESP-IDF（构建/烧录必须在同一个 shell 里）
export IDF_PATH=<repo-root>/esp-idf
. "$IDF_PATH/export.sh"

cd <repo-root>/stackchan-node/repos/StackChan/firmware
idf.py set-target esp32s3                     # 仅首次
python3 ./fetch_repos.py                      # 拉依赖
idf.py build                                  # 构建（约 2 分钟，2493 步）
idf.py -p /dev/cu.usbmodemXXXX flash         # 烧录（约 30 秒）

# 主机侧测试（不需要硬件 —— 只用 CMake！）
cmake -S tests -B build-host-tests
cmake --build build-host-tests
ctest --test-dir build-host-tests --output-on-failure
```

**烧录分区：** bootloader(0x0) + stack-chan.bin(0x20000, 3.7MB) + partition_table(0x8000) + ota_data(0xd000) + generated_assets(0xa00000, 2.3MB)
**固件配置：** `CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN=y`、SPIRAM 80MHz、BLE NimBLE、QIO flash 16MB
**依赖：** mooncake v2.3.3、xiaozhi-esp32 v2.2.4（已打补丁）、ArduinoJson v7.4.2、esp-now、smooth_ui_toolkit v2.12.0
**AI 层：** xiaozhi-esp32 v2.2.4 —— WebSocket/MQTT 客户端连 XiaoZhi 云。这就是对接 OpenClaw 的切入点。

**恢复出厂：** `<repo-root>/stackchan-node/backups/cores3_factory_uiflow2_v2.5.1.bin`
```bash
esptool.py --chip esp32s3 -p /dev/cu.usbmodemXXXX -b 460800 \
  --before=default_reset --after=hard_reset \
  write_flash --flash_mode dio --flash_size 16MB --flash_freq 80m \
  0x0 <repo-root>/stackchan-node/backups/cores3_factory_uiflow2_v2.5.1.bin
```

### 路径 2：UIFlow2 Python（快速开发推荐）

[haraisao/stackchan-uiflow2](https://github.com/haraisao/stackchan-uiflow2) —— 用 Python/MicroPython 在 UIFlow2 上实现的完整 Stack-chan。跑在出厂固件上，不需要构建系统。

- 脸部渲染（11 种表情、眨眼、说话动画）
- TTS（Google、Voicevox）+ STT（Google、Vosk）
- 对话后端：Gemini、OpenAI、LM Studio、Dify（加 OpenClaw = 新增 1 个文件）
- 电机控制（Dynamixel、SG90）、人脸追踪摄像头、带 REST API 的 Web 服务
- 通过 UIFlow2 Web IDE（`https://uiflow2.m5stack.com/`）或 USB-ampy 部署

### 路径 3：PlatformIO Arduino fork（遗留 —— 需要修复）

[plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan) fork 用 PlatformIO Arduino。**所有构建产物在 CoreS3 上黑屏 / 死循环。**

**根因（2026-08-18 通过子代理分析确认）：**
1. 缺少 `-mfix-esp32-psram-cache-issue` —— ESP32-S3 缓存勘误 CACHE-126 在 PSRAM 高负载下引发随机崩溃
2. 板型用错 `esp32s3box` —— I2C 引脚错误（SDA=41/SCL=40，CoreS3 应为 SDA=12/SCL=11）
3. M5Unified 0.1.17 与 M5GFX 0.2.27 不匹配 —— 版本配对不兼容

**修复方案：** `board = esp32-s3-devkitc-1`，build_flags 加 `-mfix-esp32-psram-cache-issue -DESP32S3 -DBOARD_HAS_PSRAM`，M5Unified 升到 `^0.2.20`。

固件位于 [plaipin-openclaw-stackchan](https://github.com/PlaiPin/plaipin-openclaw-stackchan) 的 fork：

- **Fork：** https://github.com/styles01/plaipin-openclaw-stackchan

### 关键文件
- `firmware/src/llm/OpenClaw/OpenClawClient.cpp` —— HTTP 客户端，向 Gateway 发对话请求
- `firmware/src/StackchanExConfig.h` —— 带 Agent 绑定的配置结构体
- `firmware/src/llm/OpenClaw/OpenClawConfig.h` —— 从 SPIFFS YAML 加载配置
- `Copy-to-SD/app/AiStackChanEx/SC_ExConfig.yaml.example` —— 示例配置

### 配置 YAML
```yaml
openclaw:
  host: "192.168.x.x"     # Gateway 主机（局域网或 tailnet）
  port: 18789              # Gateway 端口
  agent_id: "agent-a"        # 你的 agent id
  bot_token: "..."         # Gateway 鉴权 token
  default_model: "openclaw/agent-a"  # openclaw/<agent_id>
hermes:
  host: ""
  port: 0
  agent_id: ""
  bot_token: ""
  default_model: ""
backend: 0                 # 0 = OpenClaw, 1 = Hermes
```

## Web 配置编辑器

一个独立的 HTML 页面，直接和 Stack-chan 的 `/config` 端点通信。不需要服务端 —— 浏览器打开就能用。

```
test-harness/web-config.html    # 用任意浏览器打开
```

功能：
- 按 IP 连接任意 Stack-chan
- 查看/编辑 OpenClaw + Hermes 后端设置
- 切换激活的后端（0=OpenClaw，1=Hermes）
- 内联测试对话端点
- 查看原始配置 JSON

ESP32 固件在 80 端口提供这些端点：
- `GET /config` —— 返回当前配置 JSON
- `POST /config` —— 更新配置并持久化到 SPIFFS
- `GET /role_get` —— 返回当前角色文本
- `POST /role_set` —— 设置角色文本
- `GET /memory_get` —— 返回用户信息
- `POST /memory_clear` —— 清除用户信息
- `GET /chat?text=<msg>` —— 向 LLM 发送对话消息
- `GET /speech?say=<text>` —— 通过 TTS 朗读文本

## 测试套件

```bash
# 端到端测试（模拟完整固件管线）
python3 test-harness/e2e_test_harness.py

# 工作区写入验证（证明 Agent 绑定是真的）
python3 test-harness/workspace_write_test.py
```

### 测试结果
| 套件 | 测试数 | 通过 | 耗时 |
|---|---|---|---|
| Agent 绑定（严格） | 12 | 12 ✅ | ~2 分钟 |

全部 12 个测试使用严格身份校验：Agent A 必须说 "agent-a"，Agent B 必须说 "agent-b"，会话持久化必须包含 "testbot"。零误报。

```bash
# 跑全部测试（需要 OpenClaw + Hermes 网关在线）
python3 test-harness/test_agent_binding.py \
  --oc-key <gateway_password> \
  --hermes-key <agent_b_api_key> \
  --hermes-url http://127.0.0.1:8643

# 仅单元测试（无需网络）
python3 test-harness/test_agent_binding.py --unit-tests-only
```

## 调研

围绕 OpenClaw 通道插件架构、会话生命周期和 Agent 绑定的深度调研 —— 用子代理读源码和文档，不占主上下文。

### 第一阶段：架构盘点
- `research/channel-plugin-architecture.md` —— 通道插件工作原理
- `research/hermes-and-agent-binding.md` —— Hermes / Agent 绑定机制
- `research/http-endpoint-session-behavior.md` —— HTTP 端点会话路由
- `research/gateway-protocol-ws.md` —— WebSocket 协议分析
- `research/multi-agent-session-routing.md` —— 多 Agent 路由配置

### 第二阶段：深度源码阅读
- `research/deep-read-channel-sdk.md` —— 通道插件 SDK 内部机制
- `research/deep-read-http-internals.md` —— HTTP 端点代码追踪
- `research/deep-read-hermes-channels.md` —— Hermes 通道模式
- `research/deep-read-session-reset.md` —— 凌晨 4 点重置与通道持久化
- `research/deep-read-device-patterns.md` —— 现有机器人/设备模式

### 当前计划
- `research/CURRENT_PLAN.md` —— 活文档：计划与发现

## 运维笔记（2026 年 9 月）

针对全天候语音链路做的加固 —— 全部在服务端，无需重烧固件：

| 问题 | 方案 | 配置 |
|---|---|---|
| 空闲一段时间后 WS 掉线 | 在 3 秒 TCP `ws.ping()` 之上叠加应用层 `{"type":"ping"}`（每 60 秒） | `STACKCHAN_WS_APP_PING_MS`（设 0 关闭） |
| TTS 播报中途中断 | 自激守卫：TTS 流播放期间，主机扬声器被机器人麦克风拾音产生的 `abort` / `listen:detect` 会被吞掉；同一信号 2 秒内重复出现则视为真实打断并放行 | `STACKCHAN_TTS_INTERRUPT_GUARD`、`STACKCHAN_TTS_INTERRUPT_GUARD_WINDOW_MS` |
| 语速太慢 | edge-tts SSML 语速，实测同一句 `+30%` 后约 6.9s → 5.3s | `tools/tts_server.py` 的 `TTS_RATE` 环境变量 |
| 服务在退出登录/重启后存活 | PM2 托管 ai-server（OTA + WS + 控制）、TTS（edge-tts，:18002）、STT（faster-whisper，:52626） | `ai-server/ecosystem.config.js` —— venv / ffmpeg 路径 / 模型路径的踩坑记录见文件头注释 |

> 注意：机器人通过编译进固件的 OTA URL 找服务器（见
> [固件基线](#固件基线与协议版本)），所以**强烈建议给主机和机器人都绑静态
> DHCP 租约** —— IP 漂移的表现和"机器人掉线"一模一样。

### STT 链路

云端 Groq `whisper-large-v3` 为主；自带的 `tools/stt_server.py`
（faster-whisper small，OpenAI 兼容端点 `/v1/audio/transcriptions`，端口 :52626）
为离线兜底。模型权重（约 460MB）**不在 git 里** —— 请下载
`Systran/faster-whisper-small` 到 `ai-server/models/faster-whisper-small/`。

## 状态 —— v0.1（2026-08-19）

### ✅ 已完成
- 固件扩展（commit `ff2df3a`，已推送到 fork）
- Web 配置页（`test-harness/web-config.html` —— 浏览器操作，对接 ESP32 `/config` 端点）
- Agent 绑定测试套件 —— 12/12 严格身份校验通过
- 工作区文件读写测试 —— 两个 Agent 都能通过 HTTP API 写/改/读文件
- 调研第一阶段 —— 5 份调研文档
- 调研第二阶段 —— 5 份深度源码阅读
- API 参考 —— Option A（复用端口）和 Option B（独立端口）都已文档化
- 代码评审 V2 —— 4 个关键、8 个建议项（见 `CODE_REVIEW_V2.md`）
- Hermes Agent B 配置 —— 独立端口 8643 + 独立 API key（Option B）
- 官方 ESP-IDF 固件构建 + 烧录（v1.4.3，CoreS3 上可用）
- 收集可用参考仓库（`repos/working-repos/` 共 5 个）
- **Hermes-StackChan 参考** —— circlemouth fork 已分析为主架构参考
- **Profile 绑定已验证** —— Agent A 走 OpenClaw:18789，Agent B 走 Hermes:8643，严格身份测试全过
- **三仓库合并** —— 官方 v1.4.3 + circlemouth ai-server + plaipin 配置层
- **Web 配置服务** —— 设备 80 端口 GET/POST /config，HTML 编辑器，mDNS（`<your-host>.local`）
- **设备接入 ai-server** —— 全链路：设备 → mDNS → WS → ai-server → OpenClaw → Agent A
- **英文语音** —— TTS（`en-GB-LibbyNeural`）、STT（faster-whisper，英文）、英文快速应答
- **OpenClaw 鉴权** —— Bearer token 工作正常，HTTP 200
- **固件崩溃修复** —— WiFi 省电 + TCP 重连清理，空闲 SRAM 61KB（从 29KB 提升）
- **设备能说话且不崩** —— 完整对话循环：聆听 → 说话 → 聆听（不崩溃！）
- **自定义唤醒词** —— "Hey Agent A" WakeNet9 模型在 DGX Spark 上训练，烧录到模型分区
- **编译内置唤醒词已禁用** —— 固件使用我们的自定义模型，而非出厂的 "Hi Stack Chan"
- **音量控制修复** —— 修正 MCP 工具名（`self.audio_speaker.set_volume`），连接时启动音量增强
- **回复截断修复** —— 发现并修复流式分段对齐 bug，整句现在能完整读出
- **可配置 ai-server** —— 快速应答文本、冷却时间、分段限制、VAD 参数，全部走 `.env`

### 📋 TODO —— 固件（v1）
- **C1:** 给 `OpenClawClient::http_post_json()` 加会话/通道 header
- **C2:** 修复配置 YAML 回写（写入完整结构体，不只是 backend/openclaw/hermes）
- **C3:** Web 端点加鉴权 + GET /config 里隐藏 bot_token
- **C4:** `DynamicJsonDocument` 缓冲区扩到 4096
- **R1:** 限制 `chatHistory` 长度（防止无限增长）
- **R2:** chat/speech 加互斥锁（线程安全）
- **STT/VAD 调参** —— 提高 VAD 阈值（0.025 太低）、增大最大时长、修分段上限（1 句被截断）
- **唤醒词** —— 向 Espressif 提交 "Hey Agent A" 自定义 WakeNet 申请，或临时用 "Hey, Ivy"
- **POST /config 崩溃** —— 16384 栈已建但未测（当时设备断开了）
- **P1:** 修 PlatformIO 构建：`board = esp32-s3-devkitc-1`，加 `-mfix-esp32-psram-cache-issue -DESP32S3 -DBOARD_HAS_PSRAM`，M5Unified 升 `^0.2.20`
- **P2:** 或迁移到官方 ESP-IDF 构建系统（推荐）
- **P3:** 或用 UIFlow2 Python 路径（最简单，无构建系统）

### 🔮 TODO —— 未来
- **M5Burner 发布** —— 把可用固件发布到 M5Burner，一键安装（用户无需装工具链）
- **v2 通道插件** —— 正式的 OpenClaw `stackchan` 通道插件，支持外发推送、多设备、`channels list` 可见
- **ai-server OpenClaw 适配器** —— 扩展 circlemouth 的 ai-server 桥，让 OpenClaw Gateway 成为 HermesAgent 之外的另一个后端选项
- **机队管理** —— 多机器人 profile 管理 UI

## repos/ 目录

### 可用仓库（确认在 CoreS3 上能构建/启动）

| 仓库 | 来源 | 路径 | CoreS3 | 用途 |
|------|--------|------|--------|---------|
| `Hermes-StackChan/` | circlemouth/Hermes-StackChan | `working-repos/` | ✅ | **主要参考** —— 自托管 HermesAgent 后端的 fork、ai-server 桥、MCP 工具、UI 模拟器 |
| `xiaozhi-esp32/` | 78/xiaozhi-esp32 v2.2.6 | `working-repos/` | ✅ | AI/LLM 层（WebSocket/MQTT 客户端），支持 70+ 板型 |
| `HeavenlyPointer/` | r3dfish/HeavenlyPointer | `working-repos/` | ✅ | 可用的 PlatformIO 固件、卫星追踪、规范的板型配置 |
| `stackchan-mcp/` | kisaragi-mochi/stackchan-mcp | `working-repos/` | ✅ | Claude + Stack-chan 的 MCP 桥，固件 + Python MCP 服务 |
| `stackchan-bluetooth-simple/` | mongonta0716 | `working-repos/` | ❌ | 仅 Core2，但伺服/YAML 配置可参考 |

### 参考仓库（官方 + 遗留）

| 仓库 | 来源 | 路径 | 用途 |
|------|--------|------|---------|
| `StackChan/` | m5stack/StackChan | 顶层 | 官方 M5Stack 固件（ESP-IDF）—— C++ 固件、app、server、remote |
| `stackchan-uiflow2/` | haraisao/stackchan-uiflow2 | 顶层 | UIFlow2 Python 实现 —— 脸、语音、电机、对话后端 |
| `plaipin-openclaw-stackchan/` | PlaiPin/plaipin-openclaw-stackchan | 顶层 | Arduino fork（CoreS3 上不可用）—— OpenClaw 客户端代码在这里 |
| `StackChan-BSP/` | m5stack/StackChan-BSP | 顶层 | Arduino 外设库 —— 伺服、触摸、NFC、红外、RGB |
| `esp-openclaw-node/` | openclaw/esp-openclaw-node | 顶层 | ESP 节点代码 |
| `zclaw/` | （原有） | 顶层 | 附加工具 |

## 分析文档（2026-08-18）

- `analysis-official-stackchan.md` —— 官方仓库深度解析（314 行）
- `analysis-uiflow2-stackchan.md` —— UIFlow2 实现分析
- `analysis-platformio-issues.md` —— PlatformIO 根因分析（333 行）

三个子代理分别分析了官方 StackChan 仓库、UIFlow2 实现和 PlatformIO 构建失败。关键结论：

- **官方固件 = ESP-IDF v5.5.4**（不是 Arduino）。构建：`python3 fetch_repos.py && idf.py build && idf.py flash`
- **主机侧测试**用 CMake 跑（不需要设备）：`cmake -S tests -B build-host-tests && cmake --build build-host-tests && ctest --test-dir build-host-tests --output-on-failure`
- **UIFlow2 Python** 实现完整、可改造 —— 加 OpenClaw 后端只需新增 1 个 Python 文件 + 1 个配置项
- **PlatformIO 根因：** 缺 PSRAM 缓存修复 + 板型定义错误 + M5Unified 版本不匹配

## 许可证

MIT —— 见 [LICENSE](LICENSE)

---

<div align="center">

[![Buy me a coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-support-yellow?logo=buy-me-a-coffee&logoColor=white)](https://buymeacoffee.com/aitamedia)

如果这个项目帮你做出了有趣的小机器人，欢迎请作者喝杯咖啡。🤖☕

</div>
