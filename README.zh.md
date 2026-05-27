# android-viewtree-mcp

通过 ADB + uiautomator 检查 Android 视图层次结构的 MCP 服务器，支持 JDWP。

---

## 概述

本 MCP 服务器允许你通过 [MCP 协议](https://modelcontextprotocol.io) 检查 Android 设备的视图层次结构，提供以下功能：

- 导出完整的 ViewTree XML
- 按字段值查询视图（文本、类名、资源 ID、内容描述等）
- 支持多值匹配（OR 逻辑）和跨字段 OR 查询
- 列出可调试的 Java 进程（`adb jdwp`）
- 转发本地端口到 JDWP 进程进行深入检查

---

## 前置要求

| 要求 | 说明 |
|------|------|
| **Node.js >= 18** | MCP 服务器的运行环境 |
| **ADB**（Android SDK Platform Tools） | [在此下载](https://developer.android.com/tools/releases/platform-tools) — 需加入 `PATH` 环境变量 |
| **Android 设备** | 通过 USB 或无线 ADB 连接，需开启 **USB 调试** |

---

## 快速开始

```bash
# 克隆并安装
git clone <仓库地址> && cd android-viewtree-mcp
npm install

# 构建
npm run build

# 运行安装向导（检查依赖、构建、注册到 opencode.json）
npm run setup

# （可选）通过 npm link 全局可用
npm link
```

安装脚本会：
1. 检查 Node.js 和 ADB 是否可用
2. 安装依赖
3. 构建 TypeScript 项目
4. 在 `~/.config/opencode/opencode.json` 中注册 MCP 服务器

---

## 手动配置

在 `opencode.json` 中添加以下配置：

```json
{
  "mcp": {
    "android-viewtree": {
      "command": ["node", "/path/to/android-viewtree-mcp/dist/index.js"],
      "enabled": true,
      "type": "local"
    }
  }
}
```

如果已执行 `npm link`：

```json
{
  "mcp": {
    "android-viewtree": {
      "command": "android-viewtree-mcp",
      "enabled": true,
      "type": "local"
    }
  }
}
```

---

## 工具

### `dump_view_tree`

导出完整的 Android 视图层次结构。

| 参数 | 类型 | 说明 |
|------|------|------|
| `package_name` | `string`（可选） | 只返回指定包的视图 |
| `device_serial` | `string`（可选） | 目标设备序列号，省略时自动选择 |
| `language` | `"en"` \| `"zh"`（可选） | 响应语言，省略时从环境自动检测 |

### `find_views`

按条件查找视图，所有条件取 AND。

| 参数 | 类型 | 说明 |
|------|------|------|
| `text` | `string \| string[]` | 精确文本匹配（数组内 OR） |
| `text_contains` | `string \| string[]` | 不区分大小写的子串匹配（OR） |
| `text_regex` | `string` | 正则表达式匹配文本 |
| `content_desc` | `string \| string[]` | content-desc 匹配（OR） |
| `class_name` | `string \| string[]` | 类名匹配，支持短名或全限定名（OR） |
| `resource_id` | `string \| string[]` | 资源 ID 匹配（OR） |
| `package_name` | `string \| string[]` | 包名匹配（OR） |
| `clickable` | `boolean` | 可点击状态 |
| `enabled` | `boolean` | 启用状态 |
| `focused` | `boolean` | 焦点状态 |
| `checkable` | `boolean` | 可选中状态 |
| `checked` | `boolean` | 选中状态 |
| `selected` | `boolean` | 选定状态 |
| `scrollable` | `boolean` | 可滚动状态 |
| `displayed` | `boolean` | 非零边界且已启用 |
| `has_text` | `boolean` | 文本非空 |
| `has_content_desc` | `boolean` | content-desc 非空 |
| `has_resource_id` | `boolean` | 资源 ID 非空 |
| `$or` | `FindParams[]` | 跨字段 OR，与顶层字段 AND |
| `device_serial` | `string`（可选） | 目标设备序列号 |
| `language` | `"en"` \| `"zh"`（可选） | 响应语言 |

示例：

```json
// 查找文本为 "hello" 或 "world" 的 TextView
{ "class_name": "android.widget.TextView", "text": ["hello", "world"] }

// 查找可点击的按钮或包含文本 "submit" 的视图
{ "text_contains": "submit", "$or": [{ "clickable": true }, { "class_name": "Button" }] }
```

### `list_debuggable_processes`

列出可调试的 Java 进程（`adb jdwp`）。

| 参数 | 类型 | 说明 |
|------|------|------|
| `device_serial` | `string`（可选） | 目标设备序列号 |
| `language` | `"en"` \| `"zh"`（可选） | 响应语言 |

### `jdwp_connect`

通过 JDWP 转发本地端口到可调试进程并执行握手。

| 参数 | 类型 | 说明 |
|------|------|------|
| `pid` | `number` | 可调试应用的进程 ID |
| `port` | `number`（可选） | 本地 TCP 端口（默认 8700） |
| `device_serial` | `string`（可选） | 目标设备序列号 |
| `language` | `"en"` \| `"zh"`（可选） | 响应语言 |

---

## 国际化

服务端错误消息和响应支持中文和英文：

- 在工具调用中设置 `"language": "zh"` 获得中文响应
- 省略时自动从 `LC_MESSAGES` / `LANG` 环境变量检测
- 可扩展：在 `src/i18n.ts` 中添加新语言

---

## 项目结构

```
android-viewtree-mcp/
├── bin/
│   ├── setup.mjs          # 跨平台安装脚本
│   └── check-deps.mjs     # 安装后依赖检查
├── src/
│   ├── index.ts           # MCP 服务器入口
│   ├── adb.ts             # ADB 层：设备检测、Shell、JDWP
│   ├── parser.ts          # uiautomator XML 解析器
│   ├── matcher.ts         # 视图树匹配器
│   ├── i18n.ts            # 国际化模块
│   └── types.ts           # 类型定义
├── dist/                  # 编译后的 JS
├── README.md              # 英文文档
├── README.zh.md           # 中文文档
├── package.json
└── tsconfig.json
```

---

## 开发

```bash
# 监听模式
npm run dev

# 构建
npm run build

# 仅类型检查
npx tsc --noEmit
```

---

## 许可

MIT
