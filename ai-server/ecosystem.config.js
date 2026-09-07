/**
 * PM2 配置：StackChan OpenClaw Hermes — OTA / TTS / STT 三个服务
 *
 * 项目根：本文件所在目录（ai-server/）
 *
 * ┌─ stackchan-ota ────────────────────────────────────────────────┐
 * │ ai-server 主进程（Node + tsx 跑 src/index.ts）                  │
 * │   :8765  设备 WebSocket /ws  +  OTA 配置端点 /ota（POST）        │
 * │   :8766  设备控制端点（127.0.0.1 only）                         │
 * │ 注意：OTA **不是**独立进程，它是 ai-server 的一个 HTTP 端点。     │
 * │      设备(xiaozhi 固件)开机 POST /ota → 拿回 websocket 配置 →    │
 * │      改连本地 WS，从而绕过官方云。所以托管 ai-server = 托管 OTA。 │
 * └────────────────────────────────────────────────────────────────┘
 *
 * ┌─ stackchan-tts ────────────────────────────────────────────────┐
 * │ Python edge-tts 服务（tools/tts_server.py），端口 18002          │
 * │  POST /  body=文本 → 返回 24kHz mono WAV                        │
 * └────────────────────────────────────────────────────────────────┘
 *
 * ┌─ stackchan-stt ────────────────────────────────────────────────┐
 * │ Python faster-whisper 服务（tools/stt_server.py），端口 52626    │
 * │  POST /v1/audio/transcriptions（multipart）→ {"text":"..."}     │
 * │  定位：云端 Groq whisper-large-v3 的**兜底**。                   │
 * └────────────────────────────────────────────────────────────────┘
 *
 * 常用命令：
 *   pm2 start ecosystem.config.js      # 启动三个服务
 *   pm2 restart stackchan-ota          # 改了 .env 或 src/ 后（tsx 直接读源码，无需 build）
 *   pm2 restart stackchan-tts          # 改了 tools/tts_server.py 后
 *   pm2 restart stackchan-stt          # 改了 tools/stt_server.py 后
 *   pm2 logs stackchan-ota             # 看 OTA/设备连接日志
 *   pm2 save                           # 保存进程列表
 *
 * 依赖要点（踩过的坑，勿删）：
 *  1. cwd 必须是 ai-server：`src/index.ts` 用 `import 'dotenv/config'` 按 cwd 找 .env，
 *     cwd 错了会导致 .env 全部加载失败（端口回退默认、后端地址丢失）。
 *  2. TTS 必须用 `.venv/bin/python`：edge_tts **只装在这个 venv 里**，
 *     系统 /usr/local/bin/python3(3.14.7) 和 managed python 都没有。
 *     （venv 的 python 是软链到 /usr/local/opt/python@3.14，所以 ps 里看到的是
 *      Cellar 路径，属正常，不要因此以为它在用系统 python。）
 *  3. TTS 调 ffmpeg 转码，ffmpeg 在 ~/bin（软链到 CatPaw.app 内），
 *     非标准路径，**必须**进 PATH，否则合成时 500。
 *  3b. TTS_VOICE 必须设 zh-CN-XiaoxiaoNeural。脚本默认值是 en-GB-LibbyNeural，
 *      英文嗓音读中文会让 edge-tts 抛 NoAudioReceived（接口 500，但进程不崩，
 *      只是每次播报都失败——很隐蔽，必须实测一次中文合成才能发现）。
 *  4. STT 用另一个 venv `.venv-stt`（Python 3.12，faster_whisper 只装在那儿），
 *     与 TTS 的 `.venv`（Python 3.14）**不是同一个**。
 *  4b. STT_MODEL 必须指向项目内 `models/faster-whisper-small` 的**完整路径**。
 *      直接写 "small" 会去 HuggingFace 缓存找，而
 *      ~/.cache/huggingface/hub/models--Systran--faster-whisper-small 是空壳
 *      （只有 trees/refs 元数据，没有 snapshots/model.bin），联网又拉不到
 *      → LocalEntryNotFoundError → 进程起不来。
 *  4c. STT_LANGUAGE 必须设 zh（脚本默认 en，不设会把中文当英文转写）。
 *  5. 这三个服务都不需要代理：edge-tts、faster-whisper(本地)、后端 127.0.0.1:18789
 *     均直连可达。不要像 stackchan-bridge 那样清空代理变量——此处若误清会影响外网调用。
 *  6. 改 env 后普通 `pm2 restart` 不会刷新环境变量，需
 *     `pm2 delete <name> && pm2 start ecosystem.config.js --only <name>`。
 */

const os = require('os');
const path = require('path');

const ROOT = __dirname;
// Managed Node (WorkBuddy). Replace with `process.execPath` if you run pm2
// under a system Node that can execute the tsx shebang script directly.
const NODE_BIN = path.join(os.homedir(), '.workbuddy/binaries/node/versions/22.22.2-2/bin/node');
const VENV_PY = path.join(ROOT, '.venv/bin/python');
const VENV_STT_PY = path.join(ROOT, '.venv-stt/bin/python');

// ffmpeg lives in ~/bin (non-standard), TTS transcoding hard-depends on it
const BASE_PATH = [
  path.join(os.homedir(), 'bin'),
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/opt/homebrew/bin',
].join(':');

module.exports = {
  apps: [
    {
      // 1) ai-server：承载 OTA 端点(/ota) + 设备 WebSocket(/ws) + 设备控制(:8766)
      name: 'stackchan-ota',
      cwd: ROOT,
      // 用 tsx 直接跑 TS 源码（与改造前的启动方式一致，避免 dist 与 src 不同步的风险）。
      // node_modules/.bin/tsx 是带 shebang 的 node 脚本，pm2 可用 node 解释器直接跑。
      script: path.join(ROOT, 'node_modules/.bin/tsx'),
      interpreter: NODE_BIN,
      args: 'src/index.ts',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // tsx 启动要编译 TS，10 秒内起不来就算失败
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '600M',
      env: {
        NODE_ENV: 'production',
        PATH: BASE_PATH,
      },
      out_file: path.join(ROOT, 'logs/ota-out.log'),
      error_file: path.join(ROOT, 'logs/ota-error.log'),
      merge_logs: true,
      time: true,
      watch: false,
    },

    {
      // 2) TTS：edge-tts → WAV，供 ai-server 的 STACKCHAN_LOCAL_TTS_URL 调用
      name: 'stackchan-tts',
      cwd: ROOT,
      script: path.join(ROOT, 'tools/tts_server.py'),
      interpreter: VENV_PY,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: '400M',
      env: {
        // print() 到 stderr 要实时进 pm2 日志
        PYTHONUNBUFFERED: '1',
        TTS_PORT: '18002',
        // 嗓音必须显式指定：脚本默认值是 en-GB-LibbyNeural（英文嗓音），
        // 用它读中文 edge-tts 会抛 NoAudioReceived → 接口 500。
        // 项目文档规定的启动方式即带此变量，见 HANDOFF-FIRMWARE-REBUILD.md /
        // QUANT-BROADCAST-IMPLEMENTATION.md。
        TTS_VOICE: 'zh-CN-XiaoxiaoNeural',
        // 纯 ASCII（英文）文本走这个嗓音
        TTS_FALLBACK_VOICE: 'en-GB-LibbyNeural',
        PATH: BASE_PATH,
      },
      out_file: path.join(ROOT, 'logs/tts-out.log'),
      error_file: path.join(ROOT, 'logs/tts-error.log'),
      merge_logs: true,
      time: true,
      watch: false,
    },

    {
      // 3) STT：faster-whisper 本地转写，OpenAI 兼容端点 /v1/audio/transcriptions
      //    端口 52626 —— 必须与 .env 的 HERMES_STT_FALLBACK_URL 对上。
      //    定位：云端 Groq whisper-large-v3 的**兜底**。Groq 需 Clash 英国节点，
      //    网络不通时 ai-server 自动回落到这里，语音链路才不至于全废。
      name: 'stackchan-stt',
      cwd: ROOT,
      script: path.join(ROOT, 'tools/stt_server.py'),
      interpreter: VENV_STT_PY,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // 模型在模块级加载（实测 ~3s），放宽启动判定避免加载期被误判失败
      min_uptime: '30s',
      max_restarts: 10,
      restart_delay: 5000,
      // whisper small 常驻约 0.5G，给足额度
      max_memory_restart: '1G',
      env: {
        PYTHONUNBUFFERED: '1',
        STT_PORT: '52626',
        // 必须指向项目内的本地副本，不能用 "small"（见头注释 4b）
        STT_MODEL: path.join(ROOT, 'models/faster-whisper-small'),
        // 脚本默认 en，不设 zh 会把中文当英文转写，且不会加中文 initial_prompt
        STT_LANGUAGE: 'zh',
        PATH: BASE_PATH,
      },
      out_file: path.join(ROOT, 'logs/stt-out.log'),
      error_file: path.join(ROOT, 'logs/stt-error.log'),
      merge_logs: true,
      time: true,
      watch: false,
    },
  ],
};
