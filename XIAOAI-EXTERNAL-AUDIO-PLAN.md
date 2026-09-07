# 外接音箱（小爱）外放增强 · 实施方案

> 日期：2026-09-03
> 目标：让 StackChan（瓦力，CoreS3）的 AI 回复通过**外接音箱**（用户现有小爱音箱，按普通蓝牙音箱对待）播放，音质优于 CoreS3 自带小喇叭。
> 约束：零刷机、零固件改造；不改 session.ts；默认关闭不影响现状。

---

## 一、结论先行

| 想法 | 是否可行 | 原因 |
|---|---|---|
| CoreS3 直接**蓝牙配对**连小爱当外放 | ❌ | 固件只启用 BLE(NimBLE)，未启用经典蓝牙 A2DP；固件音频走 WiFi 语音链路，无法再经蓝牙外放。要支持需固件级改造，已排除。 |
| 小爱当**麦克风**收音 | ❌ | 小爱蓝牙只有 A2DP 单向播放，麦克风流被小米云独占，无法取出。 |
| **小爱当「普通蓝牙音箱」外放** | ✅ | ai-server 所在 Mac 连接小爱（A2DP 播放），把 TTS 输出改走 afplay 播到 Mac 默认输出设备（= 小爱）。改动小、风险低。 |

**推荐落地路线**：小爱 = Mac 的蓝牙音箱；StackChan 的回复由 ai-server 播放到 Mac 默认输出 → 小爱喇叭。**收音仍走 CoreS3**（小爱麦取不到，此方案已是最优）。

---

## 二、前提检查（动手前先确认）

1. **固件蓝牙结论**（已核实）：
   - `firmware/sdkconfig.defaults`：`CONFIG_BT_ENABLED=y` + `CONFIG_BT_NIMBLE_ENABLED=y` → **BLE only**，无 A2DP。确认路线一不可行。
2. **Mac 有 `afplay`**（已确认 `/usr/bin/afplay`，macOS 原生，支持 `-v` 音量，播到系统默认输出设备）。`afplay` 无指定设备选项，靠系统默认输出路由。
3. **现有配置项已存在**（`.env.example`，默认关闭）：
   ```
   STACKCHAN_LOCAL_TTS_OUTPUT_ENABLED=false
   STACKCHAN_LOCAL_TTS_OUTPUT_TARGET_NAME=JBL Flip 3
   STACKCHAN_LOCAL_TTS_OUTPUT_VOLUME=0.35
   STACKCHAN_LOCAL_TTS_FALLBACK_M5_VOLUME=62
   ```

---

## 三、让小爱当「Mac 的蓝牙音箱」—— 连接步骤

> 小爱音箱已开机。步骤如下（在 Mac 上操作）：

1. **打开小爱的蓝牙可被发现**：
   - 手机「小爱音箱」App → 我的 → 该音箱 → **蓝牙设置** → 打开「音箱蓝牙可被发现」。或对小爱喊「小爱同学，打开蓝牙」。
2. **Mac 搜索并连接**：
   - Mac 菜单栏 → 系统设置 → 蓝牙 → 开启蓝牙 → 设备列表点小爱音箱 → 连接。
   - 配对后小爱会被识别为**音频输出设备（A2DP）**，不是普通文件传输设备。
3. **把默认输出切成小爱**：
   - Mac → 系统设置 → **声音 → 输出** → 选择小爱音箱。
   - （可选验证）任意播放音乐/提示音，确认从小爱喇叭出声。或命令行测试：
     ```bash
     # 生成一个 1 秒 440Hz 测试音并播放
     afplay /System/Library/Sounds/Ping.aiff
     ```
4. **确认 Mac 识别**：
   ```bash
   system_profiler SPAudioDataType   # 输出设备列表里应能看到小爱
   ```

---

## 四、代码改动（ai-server 外放走 afplay）

### 改动文件（唯一）
`ai-server/src/local_audio_output.ts` —— 从 Linux PipeWire(`wpctl`/`pw-play`) 实现改为 macOS `afplay` 实现。**导出接口不变**，故 `session.ts` **零改动**。

### 目标接口语义（保持原签名，不改调用方）
```ts
readLocalTtsOutputConfig(env) → LocalTtsOutputConfig
resolveLocalTtsOutputTarget(config) → Promise<string | null>   // macOS: 校验 afplay+enabled，返回 'mac-default'
playWavOnLocalTarget(target: string, wav: Buffer): Promise<void> // macOS: 写临时wav → afplay -v <vol> 播 → 删临时
```

### macOS 实现要点
- `afplay` 需**文件路径**（不吃 stdin）：把 `wav: Buffer` 写到系统临时目录（`os.tmpdir()` 下的随机文件，如 `os.tmpdir()/stackchan-tts-<rand>.wav`），播完 `finally` 删除。
- 音量：`afplay -v <volume>`，volume ∈ 0..1（现有 config.volume 默认 0.35）。
- 播放目标 = Mac **系统默认输出设备**（无法在 afplay 指定设备）。设备选择在 Mac「声音设置 → 输出」完成。
- `resolveLocalTtsOutputTarget`：`enabled` 为真 → 检查 `afplay` 可执行 → 返回 `'mac-default'`。返回 null 则退回 CoreS3 喇叭（沿用 session 逻辑）。
- 保持跨平台不破坏：非 macOS 仍可尝试，但以 `afplay` 存在为前提，缺省返回 null 走原 M5 喇叭兜底。

### 时序（沿用 session.ts 现成逻辑，不改）
```
TTS 段生成 wav
  → prepareLocalTtsOutput: resolve → target
  → startLocalSegmentPlayback: playWavOnLocalTarget(target, wav)  // afplay 到 Mac 默认输出=小爱
  → 同时 CoreS3 喇叭被自动静音(volume 0)，播完 restoreM5Speaker 恢复
```

---

## 五、启用与回滚

### 启用（改 `.env`，再重启 ai-server）
```
STACKCHAN_LOCAL_TTS_OUTPUT_ENABLED=true
STACKCHAN_LOCAL_TTS_OUTPUT_TARGET_NAME=XiaoAi        # afplay 版仅作日志/占位，可不依赖
STACKCHAN_LOCAL_TTS_OUTPUT_VOLUME=0.5                 # 0..1 音量，自行调
STACKCHAN_LOCAL_TTS_FALLBACK_M5_VOLUME=62             # 播完恢复 CoreS3 音量
```

重启 ai-server（tsx 非 watch，须手动重启）：
```bash
kill $(lsof -tiTCP:8766 -sTCP:LISTEN)
cd ~/projects/StackChan-OpenClaw-Hermes/ai-server && ./node_modules/.bin/tsx src/index.ts
```

### 验证
1. 先做**静态验证**：Mac 声音输出切小爱后，`afplay /System/Library/Sounds/Ping.aiff` 应从外接音箱出声。
2. 重启 ai-server 后，让设备说一句话。期望 ai-server 日志出现：
   `[session xxx] local TTS output active target=mac-default; M5 speaker muted temporarily`
   → 且声音从小爱喇叭出、CoreS3 喇叭静音。
3. 说话结束后日志应出现 `M5 speaker restored volume=62`。

### 回滚
- 设 `STACKCHAN_LOCAL_TTS_OUTPUT_ENABLED=false` 重启即可回到 CoreS3 喇叭原状。
- 代码文件有 git 可还原：`git checkout ai-server/src/local_audio_output.ts`。

---

## 六、风险与边界
- **仅影响外放**；收音、VAD、STT、LLM 链路均不变。
- **无实盘/资金风险**（与 QMT 无关，纯 ai-server 音频输出）。
- 播到小爱时 CoreS3 喇叭会自动静音，避免双响（session.ts 现成逻辑）。
- 小爱需保持开机、Mac 保持蓝牙连接；若断开，afplay 播到 Mac 内置扬声器，代码不报错（需人工留意）。
- 若小爱被 Mac 蓝牙连上后**无法用作系统默认输出**（个别型号仅支持自家 App 播放），则改接任意 USB/蓝牙音箱，代码不变。

---

## 七、尚未动手，待确认
当前**未改任何代码**（local_audio_output.ts 仍为 PipeWire 版）。是否落地等你确认：
- [ ] 已完成「小爱连接 Mac + 默认输出切小爱 + afplay 出声」的前置验证
- [ ] 批准改 `local_audio_output.ts` 为 afplay 版
- [ ] 批准改 `.env` 开启并重启验证
