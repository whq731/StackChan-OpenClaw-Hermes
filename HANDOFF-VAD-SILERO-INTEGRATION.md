# HANDOFF — SileroVAD 接入 ai-server（语音端点检测升级）

> 交接时间：2026-09-03
> 交接人：WorkBuddy
> 接手段落：另一 AI / 用户
> 目标：让接手者无需翻对话历史即可继续「Silero VAD 实机验证 / 参数调优 / 后续语音链路工作」。

---

## 0. 一句话结论

本项目（StackChan 桌面瓦力机器人）的 ai-server 已完成从**自研 RMS 能量 VAD** 到 **Silero VAD（ONNX 神经网络语音端点检测）** 的引擎替换，并修复了一个会导致**每句话都被丢弃**的集成 bug。当前服务**已重启并加载修复后的代码在运行**，待用户做**实机（真实麦克风+电视噪声）验证**。

---

## 1. 项目背景速览（接手者必读）

- **仓库**：`~/projects/StackChan-OpenClaw-Hermes/`
- **ai-server**：`ai-server/`，TypeScript 桥（Node + ws + opusscript + undici），接收 StackChan 固件 WS 语音，做 VAD→STT(Groq)→LLM(OpenClaw)→TTS→Opus 播报回环。
- **架构血统**（详见上一份交接 `HANDOFF-FIRMWARE-REBUILD.md`）：固件源自 m5stack/StackChan，AI 层复用 Xiaozhi 协议（hello/listen/abort/二进制 Opus v3 帧），服务端是自研 TS（非 xiaozhi-esp32-server Python 项目）。
- **VAD 在链路中的角色**：它**不做识别**，只决定「哪些音频送云端 STT(Groq)」。作用：
  1. 电视/音乐等非人声不触发 → 少跑 Groq（省次数/省延迟）；
  2. 端点判断更准（断句不切字/不漏尾）；
  3. 瓦力自己的 TTS 残声不会自我打断（barge-in）。

## 2. 本次任务目标与结论

**用户诉求原话**：「SileroVAD 能提高识别准确率吗？还是用 fish？」→ 用户最终决定做 VAD（Fish 方向错，是 TTS 项目）。

**两条关键结论（已核实）**：
- Silero VAD **完全免费**：MIT 协议，本地 ONNX 推理，无云端调用、无 API 费。（付费的只是 Groq ASR 那层。）
- 能不能提升识别准确率：**间接能**——VAD 不识别，但通过「别把电视声/残声送进 Whisper」「端点判断更准」两条路改善送入 STT 的音频质量。

---

## 3. 本次改动的文件清单（核心交付）

### 3.1 新增文件
| 文件 | 作用 |
|---|---|
| `ai-server/src/silero_vad.ts` | SileroVAD 引擎：ONNX 推理（v5 模型，512 样本窗/32ms/帧），实现与 `LocalRmsVad` 同款 `VadEngine` 接口。异步推理链，事件在下次同步 `processPcm()` 排水。 |
| `ai-server/src/vad.ts` | 工厂：`createVad(config)`，按 `readVadEngineSelection()` 返回 `rms` 或 `silero` 引擎；含 `STACKCHAN_VAD_ENGINE` 读取逻辑。 |
| `ai-server/src/onnxruntime-node.d.ts` | 本地类型声明（onnxruntime-node 1.20.1 不带类型）。 |
| `ai-server/models/silero_vad.onnx` | **必须用 v5.1.2 tag 的模型**（约 2.3MB），sha256 前16位 `2623a2953f6ff3d2`。 |
| `ai-server/scripts/silero_smoke.cjs` | 裸 ONNX 冒烟（静音/白噪/语音概率）。 |
| `ai-server/scripts/silero_probe.ts` | 真实 wav 探测对比（silero vs rms）。 |
| `ai-server/scripts/vad_e2e.mjs` | **端到端模拟设备测试**（本轮关键验证工具，见 §5）。 |

### 3.2 修改文件
| 文件 | 改动 |
|---|---|
| `ai-server/src/session.ts` | 导入改为统一 `VadEngine`/`createVad`；对话 VAD 与 barge-in 均走工厂；`shouldUseLocalVad()` 兼容 silero 引擎选择。 |
| `ai-server/src/hermes_audio.ts` | **删除 Groq 的 Clash 代理代码**（`sttDispatcher`/`ProxyAgent` 整段移除，改走系统网络栈由 Clash 全局规则接管）。 |
| `ai-server/src/silero_vad.ts` | **§4 的 speechMs bug 修复**（本轮最重要的代码改动）。 |
| `ai-server/.env` | 删 `HERMES_STT_PROXY`；新增 VAD 引擎配置（见 §6）。 |
| `ai-server/.env.example` | 补 VAD 引擎文档，特别标注「必须用 v5.1.2 tag 模型，master 分支是坏的」。 |
| `ai-server/package.json` | `onnxruntime-node` 钉死 `^1.20.1`。 |

---

## 4. 踩掉的两个硬坑（接手者别再踩）

### 坑 A：Silero master 分支的 ONNX 模型是坏的
- 现象：`master` 分支 `silero_vad.onnx` 对真人语音输出概率 ≈0.003（Python/Node 双端交叉验证复现），模型文件本身坏。
- 解法：改用 **v5.1.2 tag** 模型，真人语音峰值 0.997、`say` 中文 TTS 峰值 0.9993。
- **警告：不要从 master 重新下载覆盖 `models/silero_vad.onnx`。**

### 坑 B（本轮新增）：onnxruntime-node 版本
- 1.29+ 砍掉了 macOS **x64** 原生库（本机是 i7-9750H，x64），装了直接报找不到 binding。
- 解法：钉死 **1.20.1**（仍含 darwin/x64）。它不带类型声明 → 补 `onnxruntime-node.d.ts`。

### 坑 C（本轮新增，最重要的 bug）：utteranceEnded 时 speechMs 上报为 0 → 每句话被丢弃
- 根因：`silero_vad.ts` 的 `advance()` 在触发 `utteranceEnded`/`ignoredShort` 的**同一拍**里先把 `activeSpeechMs`/`silenceRunMs` 清零，但事件是等**下一次同步 `processPcm()`** 才排水上报——此时活值已是 0。
- 后果：`session.ts` 的 `triggerProcess('local-vad')` 看到 `speechMs=0 < minSpeechMs(240)`，判定「太短」，把**整段有效语音丢弃**并重启监听 → 瓦力听不见人。
- 修复：事件触发时先把真实时长存进快照 `evSpeechMs`/`evSilenceMs`（line 210），`processPcm()` 排水时若正在上报 end 事件就读快照而非清零后的活值（line 109-116）。
- 这是「异步引擎事件清空计数 vs 同步调用方排水后读值」的经典竞态，已修复。

---

## 5. 验证状态与复验方法

### 5.1 已验证（本地模拟设备端到端，无需真实硬件）
用 `scripts/vad_e2e.mjs`（模拟 StackChan 设备 WS 连接：hello → listen start → 2s 噪声 → 4.5s `say` 中文语音 → 2s 静音）连运行中的 ai-server，服务端日志结果：
```
[silero-vad] model loaded ... inputs=input,state,sr     ← 运行中加载成功
[vad speech started rms=0.1431]                          ← 2s 噪声 0 触发，人声正确触发
[vad silence ended speechMs=4032 silenceMs=608]          ← 修复后正确上报 4 秒语音
[processing source=local-vad frames=118 pcmBytes=165120]
STT: "你好瓦力,帮我看一下今天上证指数的行情。"             ← 成功送 STT 并转写
```
- 单元测试：`local_vad` 6/6 通过；`npm run build`（tsc）通过。
- **注**：`session.test.ts` 文件级会挂起（事件循环有泄漏句柄），跑内层需 `--test-timeout=8000`，内层 29/29 过——这是既有现象，非本次引入。

### 5.2 待用户实机验证（我无法代做，是唯一未闭环项）
开真实电视/音乐，对瓦力真实说话，观察两点：
1. 没说话时**是否还会误触发**（日志 `vad speech started`）——Silero 相对 RMS 的最大改进点。
2. 说长句时 **600ms 断句是否会切字**。

### 5.3 复验命令
```bash
cd ~/projects/StackChan-OpenClaw-Hermes/ai-server
node scripts/vad_e2e.mjs          # 端到端模拟设备测试（需服务在跑）
tail -f /tmp/ai-server.log        # 服务日志（若服务被重启过，重新定位日志）
```

---

## 6. 配置（`.env`）速查

```ini
# VAD 引擎选择：silero | rms
STACKCHAN_VAD_ENGINE=silero
# Silero 语音概率阈值（0~1，默认 0.5，调高更严）
STACKCHAN_SILERO_THRESHOLD=0.5
# 断句静音时长（ms），从 900 收紧到 600
STACKCHAN_VAD_END_SILENCE_MS=600
# Silero 逐窗概率日志（诊断用）
STACKCHAN_SILERO_DEBUG=0
# 模型路径覆盖（默认基于模块位置解析，一般不用设）
# STACKCHAN_SILERO_MODEL_PATH=/abs/path/silero_vad.onnx
```
- **切回旧 RMS**：把 `STACKCHAN_VAD_ENGINE` 改回 `rms` 重启即可，代码无需动。
- 老 RMS 阈值/静音参数（`STACKCHAN_VAD_RMS_THRESHOLD` 等）在 silero 模式下不生效；silero 用 `STACKCHAN_SILERO_THRESHOLD` 当概率门槛（复用 `config.rmsThreshold` 字段传入）。

---

## 7. 当前运行状态（接手时请核对）

- ai-server 当前以 **`tsx src/index.ts`（dev，非 watch）** 方式运行，PID 需 `pgrep -fl "tsx src/index.ts"` 现查（重启过会变）。日志落在 `/tmp/ai-server.log`。
- **服务已含本次 speechMs 修复**，Silero 引擎已确认加载成功。
- 端口：WS `8765/ws`、control `8766`、media `/media`。后端 OpenClaw gateway 在 `18789`（另一个 node 进程，勿动）。

### 重启命令（如后续改代码需重载）
```bash
cd ~/projects/StackChan-OpenClaw-Hermes/ai-server
# 杀掉旧 tsx 进程后：
node ./node_modules/.bin/tsx src/index.ts > /tmp/ai-server.log 2>&1 &
```

---

## 8. 下一步建议（给接手 AI / 用户决策）

1. **用户实机验证**（§5.2）是最优先未闭环项——确认电视/音乐不误触发、断句正常。
2. 若偶发误触发：先调 `STACKCHAN_SILERO_THRESHOLD` 到 0.55~0.6 试，别急着改引擎。
3. 若 600ms 断句切字：把 `STACKCHAN_VAD_END_SILENCE_MS` 调回 700~900。
4. 长期方向（本次对话已调研、未实施，见 `research/xiaozhi-esp32-server-analysis.md`）：
   - `context_providers`：把行情/持仓注入系统提示词（用户暂缓，说先做 VAD）；
   - 监控 Groq 的 429 限流（对话中曾出现"使用量超限，2026-09-03 13:13 重置"），本地 fallback STT 在 `127.0.0.1:52626`。

---

## 9. 相关参考文件
- `research/xiaozhi-esp32-server-analysis.md` — 对 xiaozhi-esp32-server（Python 版服务端）的完整调研，含 context_providers 思路。
- `HANDOFF-FIRMWARE-REBUILD.md` — 固件层面交接（本次 VAD 只涉及 ai-server，未动固件）。
- `.workbuddy/memory/2026-09-03.md` — 本次全部工作的流水日志。
