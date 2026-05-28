# Session Status: ART JDWP Activity Field Reading

## Goal
让 `ObjectInspector.snapshot()` 在 Android ART 上通过 JDWP 可靠地找到并读取 Activity 实例的字段，从而解禁 `snapshot` / `correlate` MCP 工具。

## Approaches Tested

| # | Approach | Result |
|---|----------|--------|
| 1 | `StackFrame.GetValues` (cmd 16.1) via frame 0 slot 0 | **Fail** — ART 返回 error 32 (invalid slot)，frame 1 返回 error 30 (invalid frame)。主线程帧不暴露局部变量槽位 |
| 2 | `ReferenceType.Instances` (cmd 2.4) | **Fail** — ART 始终返回 0，不实现该命令 |
| 3 | `ObjectReference.InvokeMethod` (cmd 9.6) | **Fail** — 对 Activity 对象挂死，断开连接时 app 崩溃（根因同 getValues） |
| 4 | **ACR 回退方案** (读 ActivityClientRecord) | **Success** — ActivityClientRecord 的 44 个字段全部可读，包括 window、packageInfo、activityInfo、paused/stopped 等 |

## Key Findings

### getValues 在 ART 上的限制
- **对 Activity/ComponentActivity 子类对象会确定性地挂死** — 已用 4s 超时确认
- 对其他系统对象（ActivityThread、ArrayMap、ActivityClientRecord）**正常工作**
- 挂死时断开 JDWP 连接会导致 app 立即崩溃，需要完全重启

### 修复
- **ArrayValues 回复解析偏移量修复** (`src/jdwp.ts:692`)：之前从 offset 1 解码，应该是 offset 5（JDWP 格式：`typeTag(byte) + length(int32) + tagged-values`）
- **Connect 时序修复** (`src/jdwp.ts:89`)：Node.js ESM 下不能分两次 await（connect 事件 + 握手指令），必须在 connect 回调内完成握手

### 新增 API
- `referenceTypeMethods(typeId)` — JDWP cmd 2.5，枚举类型方法
- `invokeMethod(objectId, threadId, classTypeId, methodId, args?)` — JDWP cmd 9.6，调用对象方法（VM 须暂停）
- `isActivitySubclass(typeId)` — 链式检测类型是否继承自 `android.app.Activity`
- `acrSnapshot(jniSig)` — 通过 ActivityClientRecord 读取 Activity 状态的回退路径

### Field 过滤
- `$` 开头和 `serialVersionUID` 的字段已被 `inspector.ts:373` 和 `:148` 过滤（含 Kotlin 编译器生成的 `$stable`）

## Architecture Decisions
1. **SKIP** 直接读 Activity 对象字段 — 因为 `getValues` 挂死
2. **INSTEAD** 走 ACR 链路：`ActivityThread -> mActivities (ArrayMap) -> mArray[] -> ActivityClientRecord -> 44 字段`
3. 对 map 中的每个 ACR，通过 `activity` 字段校验是否为目标 Activity（对比 JNI signature）
4. ACR 字段批量读取（每批 30 个），对 object 引用进行单层类型解析（不递归防挂死）

## Remaining Work
1. MCP server 完整端到端测试 — 验证 `inspect_object` / `tap` / `snapshot` / `correlate` 全部 4 个工具
2. 验证 Window/PhoneWindow 的 getValues 是否同样挂死（如正常工作，可通过 `Window.mDecor` 获取 DecorView 层级树）
3. 清理临时测试文件 `test_*.mjs`

## File Map
- `src/jdwp.ts` — JDWP 协议层实现（745 行），所有命令 + ART 特殊处理
- `src/inspector.ts` — ObjectInspector 实现（442 行），含 ACR 回退逻辑
- `src/index.ts` — MCP 入口，已注册 4 个工具（无变更）
