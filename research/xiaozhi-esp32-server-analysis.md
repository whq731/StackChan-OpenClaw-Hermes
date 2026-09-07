# xiaozhi-esp32-server 调研：它是什么、我们能不能用

调研日期：2026-09-03
调研对象：https://github.com/xinnan-tech/xiaozhi-esp32-server
结论一句话：**协议同源、能力高度重叠，能接上，但不建议替换现有 ai-server；当零件库抄更划算。**

---

## 一、项目定位

给 `78/xiaozhi-esp32`（ESP32 设备端固件）配的**自建后端**，把「小智云端」搬到自己机器上跑。
实现小智通信协议（Python 服务端 + Java 管理后端 + Vue 智控台 + 数字人）。

| 指标 | 值 |
|---|---|
| Star / Fork | 10,489 / 3,577 |
| License | MIT |
| 创建 / 最后推送 | 2025-02-02 / 2026-09-02（活跃） |
| 主导 | 华南理工大学刘思源教授团队 |
| 默认语言 | JavaScript（主体 Python 在 `main/xiaozhi-server/`） |
| 支持协议 | WebSocket、**MQTT+UDP 网关**、MCP 接入点、声纹、知识库 |
| 官方免责 | 「功能未完善，且未通过网络安全测评，请勿在生产环境中使用」 |

仓库结构：

```
main/
├─ xiaozhi-server/     # Python 服务端（我们要关注的部分）：core/ models/ plugins_func/
├─ manager-api/        # Java 管理后端（全模块安装才需要）
├─ manager-web/        # Vue 智控台
├─ manager-mobile/     # H5 移动端
└─ digital-human/      # 数字人（python start.py → :8006）
```

## 二、两种部署方式

| 方式 | 组成 | 配置存放 | 资源要求 |
|---|---|---|---|
| 最简化安装 | 只跑 xiaozhi-server | `data/.config.yaml`（无数据库） | FunASR 2C4G；全 API 2C2G |
| 全模块安装 | server + manager-api + manager-web | 数据库 | FunASR 4C8G；全 API 2C4G |

- Docker 镜像自 0.8.2 起**只发行 x86**（arm64 需自行编译）。
- 源码部署：`conda create -n xiaozhi-esp32-server python=3.10`，需 libopus + ffmpeg。
- `requirements.txt` 钉死 `torch==2.2.2 / torchaudio==2.2.2 / funasr==1.2.7 / websockets==14.2`。

**设备绑定/激活**：只有全模块模式才有 6 位绑定码（`check_bind_device` 依赖 manager-api 下发的 private_config）。
最简化模式 `private_config = {}` → `need_bind` 保持 False，**不需要激活，设备直连即可**。

## 三、能力清单（已实现）

核心架构（MQTT+UDP / WS / HTTP + 控制台）、流式 ASR+TTS、VAD、声纹识别（3D-Speaker）、
多 LLM 对话、多 VLLM 视觉、意图识别（function_call / intent_llm）、
记忆（mem0ai / PowerMem / mem_local_short）、RAGFlow 知识库、
工具调用（客户端 IoT / MCP 接入点 / 服务端 MCP / 自定义函数）、
MQTT 指令下发、Web 管理后台、插件系统（热加载）。

组件矩阵：

| 模块 | 选项 |
|---|---|
| VAD | SileroVAD（本地，免费） |
| ASR | 本地 FunASR / SherpaASR；云端 FunASRServer、火山、讯飞、腾讯、阿里、百度、**OpenAI ASR**、**GroqASR** |
| LLM | 任何 OpenAI 兼容接口（阿里百炼/火山/DeepSeek/智谱/Gemini/讯飞）、Ollama、Dify、FastGPT、Coze、Xinference、HomeAssistant |
| VLLM | OpenAI 兼容视觉模型 |
| TTS | EdgeTTS、讯飞、火山、腾讯、阿里、CosyVoice、OpenAITTS、Minimax 等；本地 GPT-SoVITS/FishSpeech/Index-TTS |
| Memory | mem0ai / PowerMem / mem_local_short / nomem |
| Intent | intent_llm / function_call / nointent |
| Rag | RAGFlow |

## 四、关键源码事实（已核实）

1. **WS 接入无路径限制**：`core/websocket_server.py` 只取 `server.port`（默认 8000）`websockets.serve(...)`，
   不校验 path；设备连 `ws://<host>:8000/xiaozhi/v1/` 或任意路径都能握手。
2. **鉴权可选**：`server.auth.enabled` 默认 False，`allowed_devices` 为空即不校验。
3. **握手**：`handleHelloMessage` 读 `audio_params` 与 `features`；
   **只有 `features.mcp` 为真才 `MCPClient()` 并发 `initialize`**，否则不会初始化设备端 MCP。
4. **欢迎消息**：`config.yaml` 的 `xiaozhi:` 段 —— `type: hello, version: 1, transport: websocket,
   audio_params{format: opus, sample_rate: 24000, channels: 1, frame_duration: 60}`。
   （version 1 是 JSON 握手版本，与二进制音频帧 v2/v3 不是一回事。）
5. **LLM OpenAI 适配器** `core/providers/llm/openai/openai.py`：
   ```python
   self.model_name = config.get("model_name")
   self.api_key    = config.get("api_key")
   self.base_url   = config.get("base_url") or config.get("url")
   self.client = openai.OpenAI(api_key=..., base_url=..., timeout=...)
   ```
   → **只带 api_key，不会带任何自定义 header**。
6. **Groq 是官方现成模板**（`GroqASR`，`base_url=https://api.groq.com/openai/v1/audio/transcriptions`），
   正是我们 ai-server 现在用的那条链路。
7. **context_providers**：可配多个 URL + headers，把外部数据注入系统提示词（配置注释举例：健康数据、股票信息）。
8. 绑定码逻辑 `core/handle/receiveAudioHandle.py::check_bind_device` 依赖 `conn.bind_code`，
   来自 manager-api 的 private_config。

## 五、与本项目 ai-server 的能力对照

| 能力 | xiaozhi-esp32-server | 我们 ai-server（TypeScript） | 说明 |
|---|---|---|---|
| WS + Opus 协议 | ✅ | ✅ | 同一套协议，设备端无需改固件 |
| ASR | FunASR/Sherpa/Groq/OpenAI ASR | Groq whisper-large-v3 + 本地 faster-whisper 兜底 | 打平 |
| VAD | SileroVAD | 自研 RMS VAD（带静音/电视噪声过滤） | 我们按中文场景调过 |
| LLM | OpenAI 兼容 / Dify / Ollama … | OpenClaw Gateway（agent 绑定 + 工作区 I/O）+ Hermes | **我们更强**（agent/频道身份/工作区） |
| TTS | EdgeTTS 等 15+ | 本地 edge-tts :18002 | 打平 |
| 设备端 MCP | ✅（依赖 features.mcp） | ✅（stackchan_* 13 工具，已跑通） | 需验证 v2.2.4 是否声明 features |
| 服务端 MCP | ✅ | ✅（8 工具，已注册进 OpenClaw） | 打平 |
| 长期记忆 | mem0ai / PowerMem / 本地短期 | 靠 OpenClaw 侧记忆文件 | 它更完整 |
| RAG | RAGFlow | 无 | 它更强 |
| 声纹 | 3D-Speaker | 无 | 它更强 |
| 多用户/多设备管理 | 智控台 + manager-api | 无（单设备） | 它更强 |
| 待机播报 / 快速应答 / 幻觉黑名单 | 无（有唤醒词缓存，不同机制） | ✅ 已调好 | 我们更强 |
| 量化播报 / 行情注入 | 仅 context_providers（系统提示词注入） | MCP 播报工具（8 个，端到端已通） | 思路可互补 |

## 六、本机可行性（已实测环境）

- 架构 `x86_64`，Intel i7-9750H → **Docker 官方 x86 镜像可用**（但本机没装 Docker）。
- 内存 16 GB、磁盘可用 ~61 GB → 跑 FunASR(2C4G) 或全 API 模式都够。
- Python：本机有 3.13.12（managed）/ 3.9.6（system），项目要求 **3.10** → 需 conda 新建环境。
- 已有 `ai-server/.venv-stt`（faster-whisper），可复用思路但不必混用。

## 七、接入路径（若要试）

```
设备固件 v2.2.4
  └─ websocket_url → ws://<mac-ip>:8000/xiaozhi/v1/
       └─ xiaozhi-esp32-server (Python, :8000)
            ├─ VAD  SileroVAD
            ├─ ASR  GroqASR（或本地 FunASR）
            ├─ LLM  type: openai, base_url=http://127.0.0.1:PORT（反代 → OpenClaw）
            ├─ TTS  EdgeTTS
            └─ MCP  features.mcp 为真时初始化设备端工具
```

`.config.yaml` 关键片段：

```yaml
selected_module:
  VAD: SileroVAD
  ASR: GroqASR            # 或 FunASR（需下 SenseVoiceSmall 模型）
  LLM: OpenClawLLM        # 自定义名，在 LLM: 段里定义
  TTS: EdgeTTS
  Memory: nomem
  Intent: nointent

LLM:
  OpenClawLLM:
    type: openai
    base_url: http://127.0.0.1:18789/v1     # 建议指向本地反代
    model_name: openclaw/main
    api_key: <OpenClaw Gateway Key>

ASR:
  GroqASR:
    type: openai
    api_key: <groq key>
    base_url: https://api.groq.com/openai/v1/audio/transcriptions
    model_name: whisper-large-v3
    output_dir: tmp/

server:
  ip: 0.0.0.0
  port: 8000
  auth:
    enabled: false
```

## 八、接入的坑（按风险排序）

1. **OpenClaw 会话头会丢**（高）
   服务端用标准 openai SDK，只带 `api_key`，不会带
   `x-openclaw-session-key` / `x-openclaw-message-channel`。
   我们此前结论：「裸 session key 会被重挂到默认 agent」。
   → 必须中间插一个极简反代（20 行 Python/Node），注入这两个 header，`base_url` 指向反代。
   `model_name: openclaw/main` 可完成 agent 路由。
2. **协议/版本漂移**（高）
   我们的固件是 xiaozhi-esp32 **v2.2.4（2025 早期）**，服务端是 2026-09 最新版。
   `features`（mcp / aec）是后来加的字段 —— 若 v2.2.4 的 hello 不声明 `features.mcp`，
   服务端**不会初始化设备端 MCP**，13 个 `stackchan_*` 工具全废。
   → 接之前先看服务端日志里 `客户端特性:` 那行到底打印了什么。
3. **唤醒词归属不变**：设备端 WakeNet（"Hi Walle"）在固件里，服务端 `wakeup_words` 只作用于
   文本层唤醒词缓存与开场回复，不影响设备唤醒。
4. **成本**：torch 2.2.2 + torchaudio + funasr 约 2–3 GB；全 API 模式（Groq ASR + EdgeTTS）可绕开大部分。
5. **并发/稳定性**：官方自述未过安全测评，且设备侧 `close_connection_no_voice_time=120` 等默认参数
   需要按我们机器人的使用节奏重调。

## 九、建议

**短期（现在）：不换。**
现有 ai-server 已跑通全链路（含 MCP 播报、待机/睡眠、快速应答、中文幻觉过滤、OpenClaw agent 绑定），
换成 xiaozhi-server 是净损失。

**可抄的零件（按性价比）：**
1. `context_providers` —— 把行情/持仓动态注入系统提示词，对量化播报场景直接可用，
   抄进 ai-server 只需一个定时拉取 + prompt 拼接。
2. SileroVAD —— 若要替换自研 RMS VAD 时的现成方案。
3. 插件系统 + 热加载 —— ai-server 加工具时的组织方式可参考。
4. 长期记忆（mem_local_short / PowerMem）—— 若以后想让瓦力记住跨天对话。

**中期（触发条件）：** 需要多设备管理 Web UI / 长期记忆 / RAG / 声纹时，
再考虑把服务端换成 xiaozhi-server，并用反代补齐 OpenClaw 头 + 先验证 features.mcp。
