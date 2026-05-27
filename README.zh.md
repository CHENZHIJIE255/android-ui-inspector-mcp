# android-ui-inspector-mcp

**让 AI 能「看懂」Android 屏幕。** 一个 MCP 服务器，可以导出 Android 设备实时视图树并支持搜索查询 —— 相当于给 LLM 配备了一个 Layout Inspector。支持中文和英文。

---

## 这是什么

当 AI 助手（Claude、GPT 等）需要知道 Android 设备屏幕上有什么时，这个工具给它开了一扇窗：

- **导出** 已连接设备的完整视图树（ViewTree）
- **查找** 按文本、类名、资源 ID、内容描述搜索视图，支持多值和跨字段查询
- **调试** 通过 JDWP 列出可调试进程、转发端口进行深度分析

## 快速示例

```json
// 查找所有文本为 "submit" 或 "cancel" 的可点击按钮
{ "text": ["submit", "cancel"], "clickable": true, "class_name": "Button" }

// 跨字段 OR：可滚动的视图，或者包含文本 "error" 的视图
{ "$or": [{ "scrollable": true }, { "text_contains": "error" }] }
```

## 适用场景

- **AI 自动化测试** — AI 读取屏幕内容、定位元素、决定点击哪里
- **UI 调试** — 无需 Android Studio 即可查看实时视图层次结构
- **无障碍检查** — 验证 content-desc、焦点顺序、元素可见性
- **屏幕数据提取** — 从任意 App 提取结构化 UI 数据
- **JDWP 辅助分析** — 连接可调试进程进行运行时检查

## 前置要求

| 要求 | 说明 |
|------|------|
| **Node.js >= 18** | MCP 服务器运行环境 |
| **ADB**（Android SDK Platform Tools） | [在此下载](https://developer.android.com/tools/releases/platform-tools) — 需加入 `PATH` |
| **Android 设备** | USB 或无线 ADB 连接，开启 USB 调试 |

## 快速开始

```bash
git clone <仓库地址> && cd android-ui-inspector-mcp
npm install && npm run build && npm run setup
```

或在 MCP 客户端（如 `opencode.json`）中手动配置：

```json
{
  "mcp": {
    "android-ui-inspector": {
      "command": ["node", "/path/to/android-ui-inspector-mcp/dist/index.js"],
      "enabled": true,
      "type": "local"
    }
  }
}
```

## 工具

### `dump_view_tree`

导出完整的 Android 视图树。

| 参数 | 类型 | 说明 |
|------|------|------|
| `package_name` | `string`（可选） | 只返回指定包的视图 |
| `device_serial` | `string`（可选） | 目标设备序列号，省略自动选择 |
| `language` | `"en"` \| `"zh"`（可选） | 响应语言，省略从环境自动检测 |

### `find_views`

按条件查找视图。所有顶层条件取 AND。

| 参数 | 类型 | 说明 |
|------|------|------|
| `text` | `string \| string[]` | 精确文本匹配（数组内 OR） |
| `text_contains` | `string \| string[]` | 不区分大小写的子串匹配（OR） |
| `text_regex` | `string` | 正则表达式匹配文本 |
| `content_desc` | `string \| string[]` | content-desc 匹配（OR） |
| `class_name` | `string \| string[]` | 类名，支持短名或全限定名（OR） |
| `resource_id` | `string \| string[]` | 资源 ID（OR） |
| `package_name` | `string \| string[]` | 包名（OR） |
| `clickable` / `enabled` / `focused` / `checkable` / `checked` / `selected` / `scrollable` | `boolean` | 状态筛选 |
| `displayed` | `boolean` | 非零边界且已启用 |
| `has_text` / `has_content_desc` / `has_resource_id` | `boolean` | 字段非空检查 |
| `$or` | `FindParams[]` | 跨字段 OR，与顶层字段 AND |
| `device_serial` | `string`（可选） | 目标设备序列号 |
| `language` | `"en"` \| `"zh"`（可选） | 响应语言 |

示例：

```json
// 查找文本为 "hello" 或 "world" 的 TextView
{ "class_name": "android.widget.TextView", "text": ["hello", "world"] }

// 可点击 或 类名为 Button 的视图，且包含文本 "submit"
{ "text_contains": "submit", "$or": [{ "clickable": true }, { "class_name": "Button" }] }
```

### `list_debuggable_processes`

列出可 JDWP 调试的 Java 进程（`adb jdwp`）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `device_serial` | `string`（可选） | 目标设备序列号 |
| `language` | `"en"` \| `"zh"`（可选） | 响应语言 |

### `jdwp_connect`

通过 JDWP 将本地端口转发到可调试进程。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pid` | `number` | 进程 ID |
| `port` | `number`（可选） | 本地 TCP 端口（默认 8700） |
| `device_serial` | `string`（可选） | 目标设备序列号 |
| `language` | `"en"` \| `"zh"`（可选） | 响应语言 |

## 国际化

支持中文和英文。调用时设置 `"language": "zh"` 获得中文响应，或由服务器从 `LC_MESSAGES` / `LANG` 自动检测。

## 项目结构

```
android-ui-inspector-mcp/
├── bin/
│   ├── setup.mjs           # 跨平台安装脚本
│   └── check-deps.mjs      # 安装后依赖检查
├── src/
│   ├── index.ts            # MCP 服务器入口
│   ├── adb.ts              # ADB：设备检测、Shell、JDWP
│   ├── parser.ts           # uiautomator XML 解析
│   ├── matcher.ts          # 视图树匹配
│   ├── i18n.ts             # 国际化
│   └── types.ts            # 类型定义
├── dist/                   # 编译后的 JS
├── README.md               # 英文文档
├── README.zh.md            # 中文文档
├── package.json
└── tsconfig.json
```

## 开发

```bash
npm run dev      # 监听模式
npm run build    # 编译 TypeScript
npx tsc --noEmit # 仅类型检查
```

## 许可

MIT
