# 瓦力「空闲乱转头」关闭方案（保留轻微表情）

> 目标：**空闲待机时不再让头部舵机随机左右摇头/上下瞟**，但**保留脸上的轻微表情**（眼神游离、嘴部小动、眨眼等"活物感"）。
> 本次不涉及摄像头改动（已按你要求搁置）。
>
> 适用范围：CoreS3 (M5Stack CoreS3, ESP32-S3) + 本项目 StackChan/xiaozhi 融合固件。
> 固件源码根：`~/projects/stackchan-fw/firmware`

---

## 一、为什么空闲时会乱摇头（根因）

头部"随机转头"由一个叫 `IdleMotionModifier` 的固件组件实现，它受设备状态机控制，逻辑集中在：

**`firmware/main/hal/board/stackchan_display.cc` → `StackChanAvatarDisplay::SetStatus()`**（约 480–569 行）

- 设备回到**待机 STANDBY** → `SetStatus("STANDBY")` → 走 `is_idle` 分支 → 调用 `CreateIdleMotionModifier()`（约 540 行）→ 之后每 **4~8 秒随机转头一次**（左右看 / 上下瞟 / 快速瞥一眼 / 回正），见 `firmware/main/stackchan/modifiers/idle_motion.h`。
- 设备**进入监听/说话** → `SetStatus("LISTENING"/"SPEAKING")` → 走 else 分支 → `removeModifier` 停掉转头（约 549–554 行）→ 对话结束回 STANDBY 又恢复。

**要点**：
1. "转头频率等级"是可配置的，默认 **Medium(2)**，范围 `0=Off / 1=Low / 2=Medium / 3=High`。
2. 转头等级归零时，`CreateIdleMotionModifier()` 会直接返回（`stackchan_display.cc:304` `case 0: return`），**舵机完全不转**。
3. 关键的"保留表情"保证：眼睛/嘴的轻微表情由**另一个独立的** `IdleExpressionModifier` 控制（眼神游离、嘴微动、回归中性），它在 STANDBY 时**无条件被添加**（`stackchan_display.cc:542`），**与转头等级无关**——所以关掉转头**不会**影响脸上的轻微表情。

> 备注：`blink.h`(眨眼)/`breath.h`(呼吸) 这两个 modifier 在当前固件里**实际未注册使用**（属框架预留）。你平时看到的"活物感"主要就来自 `IdleExpressionModifier` 的眼神/嘴部小动。

---

## 二、改动方案（两条路径，推荐 A）

### 方法 A：设备端设置里把「Idle movement」调到 Off（免烧录 ★首选）

这是**零编译、零烧录**的做法，改动即生效：

固件带一个设置项 **"Idle movement frequency"**（等级标签 `Off / Low / Medium / High`），入口位于设备内的 **Setup/Settings** 应用（`firmware/main/apps/app_setup/workers/ai_agent.cpp`，持久化到 NVS 键 `idle_lv`）。

操作：
1. 在 CoreS3 上进到 **Setup / Settings** 界面（该固件有 `app_launcher` 多应用框架，需从 AI Agent 主界面切到设置应用，具体手势/入口以你当前固件版本的实际 UI 为准）。
2. 找到 **Idle movement frequency** 项，从当前值切到 **Off**。
3. 保存退出。此设置写入 NVS（`idle_lv=0`），**重启后依然生效**，且只关舵机转头、保留屏幕表情。

> 注意：免烧录是否可行取决于你能从正常使用界面进到那个 Setup 页。如果你平时就是 AI Agent 单应用前台运行、找不到进 Settings 的入口，就改走**方法 B**（编译期默认值关掉）。

---

### 方法 B：改固件默认等级为 0（确定性强，需烧录）

如果设备端 UI 不便操作，或想"出厂就关掉"，改一处编译期默认值即可。

文件：**`firmware/main/hal/board/stackchan_display.h` 第 22 行**

```cpp
uint8_t idle_motion_level_ = 2;   // 改 2 → 0
```

改为 `0` 后：
- `CreateIdleMotionModifier()` 走 `case 0` 直接 return（`stackchan_display.cc:304`），**永不创建转头 modifier** → 空闲完全不摇头。
- `SetStatus` 待机分支里 `if (idle_motion_level_ > 0) CreateIdleMotionModifier();`（`stackchan_display.cc:539`）判断为假 → 不再转头。
- `IdleExpressionModifier`（眼睛/嘴表情）在 542 行**无条件保留** → 脸上的轻微表情照常。

改完需**重新编译并烧录固件**到 CoreS3。

> 若希望更彻底（连代码级开关一起留个后门），也可在 `stackchan_display.cc:304` 的 `switch(idle_motion_level_)` 保持原样，只靠默认值 `=0` 即可，不必删代码。这样以后想恢复，在设备设置里把它调回 Low/Medium/High 仍能生效（NVS 值会覆盖编译默认）。

---

## 三、预期结果

| 状态 | 改动前 | 改动后（方法 A 或 B） |
|---|---|---|
| 空闲 STANDBY | 每 4–8s 舵机随机左右摇头/上下瞟 | **头静止正对前方**，舵机不动 |
| 空闲 STANDBY（脸上） | 眼神游离/嘴微动 | **保留**（不受影响） |
| 监听 LISTENING | 停摇头 | 停摇头（无变化） |
| 说话 SPEAKING | 停摇头、嘴动发声 | 停摇头、嘴动发声（无变化） |

---

## 四、补充（本次不做，仅存档）

- **摄像头**：固件已有拍照能力（MCP 工具 `self.camera.take_photo`）与"设备→服务器 JPEG 上行"通路，但**唤醒自动拍照**属固件级新逻辑，本次按你要求**不做**。
- 摄像头是固定在瓦力脸上的，无法自主定位说话人方位；"看向说话的人"在单固定机位下现实含义是"唤醒时头归位正前方 + 拍照给 AI"，未来若要做再单独评估。

---

## 五、风险与回退

- 方法 A 无烧录风险，可随时在设备设置改回。
- 方法 B 需烧录，回退 = 把默认值改回 `2` 重烧，或在设备设置里调回（若 NVS 有值覆盖则无需重烧即可恢复摇头）。
- 改动不触碰音频、网络、交易等其它子系统，范围极小。
