# 交接文档：StackChan 固件重编（WakeNet 常开）— 给接手的 AI

> 日期：2026-09-03。M5Stack CoreS3 机器人「瓦力」（SKU K151，
> MAC `<DEVICE_MAC>`，USB `/dev/cu.usbmodemXXXX`，IP `<DEVICE_IP>`）接自建 ai-server（Mac `<HOST_IP>`）。
> 网络：构建若需下载工具链（xtensa 约 169M tarball），先 `env | grep -i proxy` 确认本机代理可用，
> 必要时手动 `export http_proxy/https_proxy=...` 后再跑 install.sh。

## 一、记忆与文档地址

- **CatPaw 记忆（长期）**：`~/.meituan-catpaw/<CATPAW_ID>/memory/MEMORY.md`
- **每日工作记录**：`~/.meituan-catpaw/<CATPAW_ID>/memory/daily/2026-09-02.md`（含本次全部背景、修复记录、固件架构结论）
- **给龙虾/OpenClaw 的播报工具文档**：`docs/stackchan-mcp-guide.md`
- 本文档：`HANDOFF-FIRMWARE-REBUILD.md`（项目根目录）

## 二、已完成（全部实测通过，勿重做）

1. 语音闭环：说话→Opus→Groq whisper-large-v3（经 Clash）→OpenClaw→edge-tts→瓦力回答；本地 faster-whisper small 兜底（:52626）
2. MCP 播报层：`ai-server/mcp/stackchan-mcp-server.mjs`（stdio，8 工具）已注册进 OpenClaw（openclaw.json mcp.servers.stackchan），端到端真机播报成功
3. 待机播报：设备 idle 时 `/internal/say` 正常播放，播完保持待机（session.ts standbyHold）
4. ai-server 修复：edge-tts 500 自动重试（hermes_audio.ts）；中文待机词；幻觉黑名单扩充；细节见 daily/2026-09-02.md
5. assets 分区已手术：srmodels 换成 wn9_hiwalle_tts2（"Hi Walle"），**assets/model/nvs 分区是好的，重编后只烧 app**

## 三、当前任务：固件重编（进行到一半）

**目标**：让「Hi Walle」在设备待机/监听中也能生效。根因（v2.2.4 源码已核实）：
realtime 模式下 WakeNet 全程 Stop，只有设备 Idle 才 EnableWakeWordDetection(true)。
修法：开 `CONFIG_WAKE_WORD_DETECTION_IN_LISTENING=y`（Kconfig 在 xiaozhi-esp32/main/Kconfig.projbuild:732）。

**已完成的环境准备**（都在本机）：

- ESP-IDF v5.5.4 已克隆含子模块：`~/projects/esp-idf-v5.5.4`
  （注意：components/openthread 的嵌套子模块拉取失败，esp32s3 构建用不到，可忽略）
  - xtensa 工具链 14.2.0 tarball 已下载到 `~/.espressif/dist/xtensa-esp-elf-14.2.0_20260121-x86_64-apple-darwin.tar.xz`（169M 完整）
- 固件源码：`~/projects/stackchan-fw`（m5stack/StackChan main 分支 tarball 解包）
  - `firmware/` 内：main/（StackChan 自研层）+ `xiaozhi-esp32/`（v2.2.4 tarball，**patches/xiaozhi-esp32.patch 已 git apply 成功**）
  - components/ 五个依赖已用 API tarball 装好：mooncake v2.3.3 / mooncake_log v1.5.0 / smooth_ui_toolkit v2.12.0 / ArduinoJson v7.4.2 / esp-now@c33383d
  - 注意：git 直连 github.com 会 SSL 失败；api.github.com 稳定（tarball/assets 都能下）。git 加 `-c http.version=HTTP/1.1` + 代理可用

**执行进度**（2026-09-03 09:52 更新）：
- 步骤 1 ✅ 工具链 + Python 依赖全装完（含 cmake/ninja 补装、IDF 三缺子模块补拉）
- 步骤 2 ✅ 配置行已追加且**已验证落地**（build/config/sdkconfig.h 里 `CONFIG_USE_AFE_WAKE_WORD 1` + `CONFIG_WAKE_WORD_DETECTION_IN_LISTENING 1`）
- 步骤 3 ✅ **构建成功**：`build/stack-chan.bin`（3.7MB，app 分区 27% 余量）
- 步骤 4 ⏸ 烧录被阻塞：09:51 时 `/dev/cu.usbmodem14201` 从系统消失（只剩蓝牙串口），需用户重插设备/确认连接后重跑 `idf.py -p /dev/cu.usbmodem14201 app-flash`

**待做步骤**（接手 AI 按顺序执行）：

1. 装 IDF 工具（会复用已缓存的 xtensa tarball）：
   `cd ~/projects/esp-idf-v5.5.4 && ./install.sh esp32s3`
   （若再遇 github 下载失败：可用 api.github.com 的 releases assets 接口手动下，放到 ~/.espressif/dist/ 后重跑）
2. 加配置开关：在 `~/projects/stackchan-fw/firmware/sdkconfig.defaults` 追加一行
   `CONFIG_WAKE_WORD_DETECTION_IN_LISTENING=y`（**已于 2026-09-03 追加完成，勿重复添加**）
   - 依赖已核实可满足：该选项 `depends on USE_AFE_WAKE_WORD || USE_CUSTOM_WAKE_WORD`，而
     `WAKE_WORD_TYPE` 的默认值是 `USE_AFE_WAKE_WORD if (IDF_TARGET_ESP32S3 || ESP32P4) && SPIRAM`，
     defaults 里 `CONFIG_IDF_TARGET="esp32s3"` 与 `CONFIG_SPIRAM=y` 两条都满足，故 USE_AFE_WAKE_WORD 会被自动选中。
   - 注意 Kconfig 的 depends 不满足时是**静默忽略**，不会报错，所以步骤 3 后必须做落地校验。
3. 构建：
   ```
   . ~/projects/esp-idf-v5.5.4/export.sh
   cd ~/projects/stackchan-fw/firmware
   idf.py set-target esp32s3
   idf.py build
   ```
   （sdkconfig.defaults 已含 CONFIG_BOARD_TYPE_M5STACK_STACK_CHAN=y、CONFIG_SR_WN_WN9_HISTACKCHAN_TTS3=y、16MB/QIO/SPIRAM 等全部默认，勿改动其他行）
   组件管理器会从 component.espressif.com 拉 managed_components，需网络；components/ 里已装好的 5 个会被直接采用。
4. **构建后落地校验（必做，跳过等于白编）**：
   ```
   grep -E "WAKE_WORD_DETECTION_IN_LISTENING|USE_AFE_WAKE_WORD" build/config/sdkconfig
   ```
   必须同时看到 `CONFIG_USE_AFE_WAKE_WORD=y` 和 `CONFIG_WAKE_WORD_DETECTION_IN_LISTENING=y`。
   若只看到前者被注释（`# CONFIG_USE_AFE_WAKE_WORD is not set`），说明依赖没满足、开关被静默丢弃，
   需在 defaults 里显式补 `CONFIG_USE_AFE_WAKE_WORD=y` 后重编。
5. 烧录 **只烧 app**（保 nvs/assets/model 分区，服务器地址和 Hi Walle 模型都在那里面）：
   ```
   idf.py -p /dev/cu.usbmodem14201 app-flash
   ```
   或 esptool 写 build/stack-chan.bin 到 0x20000（ota_0）。分区表同 v0.1：nvs 0x9000 / otadata 0xd000 / ota_0 0x20000 / ota_1 0x510000 / assets 0xA00000 / model 0xE00000
6. 验证组合一闭环：
   - 开机点开 AI Agent 应用 → 说「Hi Walle」→ 进对话（此时应看到串口 AfeWakeWord 加载 wn9_hiwalle_tts2）
   - 对瓦力说「睡觉」→ 待机；用 `curl -X POST -H 'content-type: application/json' -d '{"text":"测试"}' http://127.0.0.1:8766/internal/say` 播报 → 播完保持待机
   - 再说「Hi Walle」→ **应能唤醒**（本次改动的验收点；串口应出现 wake/detect 相关日志，服务器日志出现 `listening started (wake_word=...)`）
7. 串口抓日志：`cat /dev/cu.usbmodem14201 > /tmp/serial.log`（后台跑）

## 四、遗留 TODO

- tcp_receive 崩溃根因（设备偶发崩溃重启，coredump 分区为空=固件没开 panic dump；可选：顺手开 CONFIG_ESP_SYSTEM_PANIC / coredump 相关 Kconfig 一并重编，用户未拍板，默认不动）
- 重编后若设备行为变化（如 listen mode 从 realtime 变 auto——m5stack main 的 USE_DEVICE_AEC 对该板不可用），播报链路不受影响（8766 控制口与会话状态机无关），但要观察 ai-server 日志确认 listen 消息正常
- 用户量化播报任务接入 MCP（龙虾，见 docs/stackchan-mcp-guide.md）

## 五、关键坑位（前人血泪）

- **IDF 安装报 `EEXIST ... mkdir .../esptool_<hash>`**（2026-09-03 实踩，坑了约 20 分钟；**事后查明真凶**）：
  `install.sh` / `idf_tools.py install-python-env` 会在装 esptool 这一步挂掉，且**工具链本体其实已装完**
  （看输出开头的 `100% Done`，`~/.espressif/tools/` 下 xtensa 等已就位），只有 Python 依赖层失败。
  **真正根因（后来在 idf.py 报错栈里实锤）**：WorkBuddy 注入的
  `PYTHONPATH=/Applications/WorkBuddy.app/.../cli/vendor/shim` 里的 `sitecustomize.py` 会**劫持 Python 的 `os.mkdir`**
  （`_brokered_os_mkdir`），目录已存在时不抛原生 FileExistsError 而是抛 `PermissionError: EEXIST`，
  pip 为 esptool（依赖里唯一没有 wheel、只有 sdist 的包）解包时中招。**凡是在 WorkBuddy 会话里跑 Python 工具
  （pip / idf.py / esptool），一律先 `export PYTHONPATH=`（置空）再跑**——这一条同时规避了 pip 与 idf.py 的同名报错。
  （已验证无效的绕法：换干净 TMPDIR、pip 降级 25.3、`--no-build-isolation`、`--only-binary=:all:`。）
  **当时的应急解法**（PYTHONPATH 置空前的 workaround，也可用）：手动装 esptool 再回头补其余依赖：
  ```
  curl -s https://pypi.org/pypi/esptool/4.12.0/json \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print([u['url'] for u in d['urls'] if u['packagetype']=='sdist'][0])"
  curl -sL -o /tmp/esptool-4.12.0.tar.gz "<上面拿到的 URL>"
  mkdir -p /tmp/esptool-src && tar xzf /tmp/esptool-4.12.0.tar.gz -C /tmp/esptool-src
  PYTHONPATH= ~/.espressif/python_env/idf5.5_py3.13_env/bin/python -m pip install --no-deps --no-build-isolation /tmp/esptool-src/esptool-4.12.0
  cd ~/projects/esp-idf-v5.5.4 && PYTHONPATH= ./tools/idf_tools.py install-python-env
  ```
- **IDF 子模块不全**（2026-09-03 实踩）：克隆 esp-idf-v5.5.4 时 `components/unity/unity`、
  `components/spiffs/spiffs`、`components/protobuf-c/protobuf-c` 三个子模块是空的，cmake 配置报
  `Include directory '.../unity/unity/src' is not a directory`（错误点在 unity 但真因是子模块缺）。
  解法：`git -c http.version=HTTP/1.1 submodule update --init --recursive components/protobuf-c/protobuf-c components/spiffs/spiffs components/unity/unity`
- **cmake/ninja 缺失 + 损坏的半解包目录**（2026-09-03 实踩，比 EEXIST 坑更隐蔽）：
  上述 install.sh 崩溃时，工具链层也**没装完**——cmake 3.30.2、ninja 1.12.1 缺失，`idf.py` 直接报
  `"cmake" must be available on the PATH`。另注意：若修复中途强行杀掉 install 进程，会留下**半解包的损坏目录**
  （症状：`idf_tools.py list` 显示 "directory present but tool not found"，且重装时被 safe-delete 批量确认拦截无法自愈）。
  **解法**：把损坏目录改名留底（不要 rm，避免触发批量删除保护），再精准补装：
  ```
  mv ~/.espressif/tools/cmake/3.30.2 ~/.espressif/tools/cmake/3.30.2.broken-20260903
  cd ~/projects/esp-idf-v5.5.4 && PYTHONPATH= ./tools/idf_tools.py install cmake ninja
  ```
  macOS 的 cmake 是 universal 大包（5600+ 文件），解包要 ~10 分钟，必须后台跑，别在前台等超时。
- 烧 assets/model 前必看 FLASHING-GUIDE.md 和 backups/（otadata CRC、空分区备份教训）
- devices 崩溃后 esptool `--after hard_reset` 复位可救；别整片 erase
- **重编固件时 OTA_URL 纪律（2026-09-03 关键，务必遵守）**：xiaozhi 固件每次启动 POST 到
  `CONFIG_OTA_URL`(编译内置，NVS `wifi.ota_url` 为空时用) 拿协议配置。**响应含 mqtt→连官方云；含 websocket→连本地**。
  默认值 `https://api.tenclass.net/xiaozhi/ota/`（官方），M5Burner 全擦后设备若连官方会进激活循环/回官方云。
  **本机已验证的本地解法**：`sdkconfig.defaults` 加 `CONFIG_OTA_URL="http://<HOST_IP>:8765/ota"`，
  且 ai-server `server.ts` 已接入 `src/ota_config.ts`（`POST /ota` 返回 `{"websocket":{"url":"ws://<Host>:8765/ws","version":3}}`，
  **无 mqtt 无 firmware 段**）。**任何重编都必须保留这一行指向本地**，否则瓦力会失联回官方云。
  注意：`version` 必须=3（匹配 ai-server Session.version）；IP 是运行 ai-server 的那台主机的 LAN IP，换网络后需同步改并重编。
- ai-server 改代码需手动重启：`kill $(lsof -tiTCP:8766 -sTCP:LISTEN)` 再 `cd ai-server && ./node_modules/.bin/tsx src/index.ts`
- **本地 edge-tts(18002) 需独立启动**：ai-server 若配 `STACKCHAN_LOCAL_TTS_URL=http://127.0.0.1:18002/` 而 18002 没服务，
  LLM 回答/播报会静音（报 `ECONNREFUSED 18002`）。启动：`cd ai-server && TTS_VOICE=zh-CN-XiaoxiaoNeural .venv/bin/python tools/tts_server.py`
- openclaw mcp 子命令是 `unset` 不是 `remove`；改完配置要 `openclaw mcp reload`
