# android-viewtree-mcp

MCP server for Android ViewTree inspection via ADB + uiautomator, with JDWP support.

---

## Overview

This MCP server lets you inspect the view hierarchy of an Android device through [MCP (Model Context Protocol)](https://modelcontextprotocol.io). It provides tools to:

- Dump the full ViewTree XML from a connected Android device
- Query views by field values (text, class, resource-id, content-desc, etc.)
- Support multiple matching values (OR logic) and cross-field OR queries
- List debuggable Java processes (`adb jdwp`)
- Forward local ports to JDWP processes for deeper inspection

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js >= 18** | Runtime for the MCP server |
| **ADB** (Android SDK Platform Tools) | [Download here](https://developer.android.com/tools/releases/platform-tools) — must be in `PATH` |
| **Android device** | Connected via USB or wireless ADB, with **USB debugging** enabled |

---

## Quick Start

```bash
# Clone and install
git clone <repo-url> && cd android-viewtree-mcp
npm install

# Build
npm run build

# Run setup (checks deps, builds, registers in opencode.json)
npm run setup

# (Optional) Make globally available via npm link
npm link
```

The setup script will:
1. Check Node.js and ADB are available
2. Install dependencies
3. Build the TypeScript project
4. Register the MCP server in `~/.config/opencode/opencode.json`

---

## Manual Configuration

If you prefer to configure manually, add this to your `opencode.json`:

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

Or if you ran `npm link`:

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

## Tools

### `dump_view_tree`

Dump the full Android ViewTree hierarchy.

| Param | Type | Description |
|-------|------|-------------|
| `package_name` | `string` (optional) | Filter to only include views from this package |
| `device_serial` | `string` (optional) | Target device serial, auto-selects if omitted |
| `language` | `"en"` \| `"zh"` (optional) | Response language, auto-detected from env |

### `find_views`

Find views matching criteria. All conditions are ANDed.

| Param | Type | Description |
|-------|------|-------------|
| `text` | `string \| string[]` | Exact text match (OR within array) |
| `text_contains` | `string \| string[]` | Case-insensitive substring match (OR) |
| `text_regex` | `string` | Regular expression match on text |
| `content_desc` | `string \| string[]` | Content description match (OR) |
| `class_name` | `string \| string[]` | Class name match, supports short or FQN (OR) |
| `resource_id` | `string \| string[]` | Resource ID match, supports full ID or suffix (OR) |
| `package_name` | `string \| string[]` | Package name match (OR) |
| `clickable` | `boolean` | Filter by clickable state |
| `enabled` | `boolean` | Filter by enabled state |
| `focused` | `boolean` | Filter by focused state |
| `checkable` | `boolean` | Filter by checkable state |
| `checked` | `boolean` | Filter by checked state |
| `selected` | `boolean` | Filter by selected state |
| `scrollable` | `boolean` | Filter by scrollable state |
| `displayed` | `boolean` | Non-zero bounds + enabled |
| `has_text` | `boolean` | Non-empty text |
| `has_content_desc` | `boolean` | Non-empty content description |
| `has_resource_id` | `boolean` | Non-empty resource ID |
| `$or` | `FindParams[]` | Cross-field OR — any sub-query match satisfies; ANDed with top-level fields |
| `device_serial` | `string` (optional) | Target device serial |
| `language` | `"en"` \| `"zh"` (optional) | Response language |

Examples:

```json
// Find all TextViews with text "hello" or "world"
{ "class_name": "android.widget.TextView", "text": ["hello", "world"] }

// Find clickable buttons OR views with text "submit"
{ "text_contains": "submit", "$or": [{ "clickable": true }, { "class_name": "Button" }] }
```

### `list_debuggable_processes`

List debuggable Java processes (from `adb jdwp`).

| Param | Type | Description |
|-------|------|-------------|
| `device_serial` | `string` (optional) | Target device serial |
| `language` | `"en"` \| `"zh"` (optional) | Response language |

### `jdwp_connect`

Forward a local port to a debuggable process via JDWP and perform the handshake.

| Param | Type | Description |
|-------|------|-------------|
| `pid` | `number` | Process ID of the debuggable app |
| `port` | `number` (optional) | Local TCP port (default: 8700) |
| `device_serial` | `string` (optional) | Target device serial |
| `language` | `"en"` \| `"zh"` (optional) | Response language |

---

## i18n

The server supports **English** and **Chinese** for error messages and responses.

- Set `"language": "zh"` in any tool call to get Chinese responses
- When omitted, the server auto-detects from `LC_MESSAGES` / `LANG` environment variables
- Extensible: add new locales in `src/i18n.ts`

---

## Project Structure

```
android-viewtree-mcp/
├── bin/
│   ├── setup.mjs          # Cross-platform setup script
│   └── check-deps.mjs     # Postinstall dependency check
├── src/
│   ├── index.ts           # MCP server entry point
│   ├── adb.ts             # ADB layer: device detection, shell, JDWP
│   ├── parser.ts          # uiautomator XML parser
│   ├── matcher.ts         # View tree filter
│   ├── i18n.ts            # Internationalization module
│   └── types.ts           # Type definitions
├── dist/                  # Compiled JavaScript
├── README.md              # English documentation
├── README.zh.md           # Chinese documentation
├── package.json
└── tsconfig.json
```

---

## Development

```bash
# Watch mode
npm run dev

# Build
npm run build

# Type-check only
npx tsc --noEmit
```

---

## License

MIT
