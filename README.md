# android-ui-inspector-mcp

**Let AI agents "see" your Android screen.** An MCP server that dumps the live Android view hierarchy and lets you search it — like Layout Inspector for LLMs.

---

## What it does

When an AI agent needs to know what's on your Android device screen, this tool gives it a direct window in:

- **Dump** the full view tree from any connected Android device
- **Find** views by text, class name, resource ID, content description — with multi-value and cross-field queries
- **Analyze** the screen at a high level — extract text, find interactive elements, understand structure
- **Debug** via JDWP — list debuggable processes and forward ports for deeper inspection

<video src="assets/demo-en.webm" controls width="720" title="AI inspecting and analyzing an Android screen">
  Your browser doesn't support video playback.
</video>

## Quick example

```json
// Find all clickable buttons with text "submit" or "cancel"
{ "text": ["submit", "cancel"], "clickable": true, "class_name": "Button" }

// Cross-field OR: views that are scrollable OR contain text "error"
{ "$or": [{ "scrollable": true }, { "text_contains": "error" }] }
```

## Use cases

- **AI automated testing** — agent reads the screen, finds elements, decides what to tap
- **UI debugging** — inspect the live view hierarchy without Android Studio
- **Accessibility checks** — verify content descriptions, focus order, element visibility
- **Screen scraping** — extract structured UI data from any app
- **JDWP-assisted analysis** — connect to a debuggable process for runtime introspection

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js >= 18** | Runtime for the MCP server |
| **ADB** (Android SDK Platform Tools) | [Download here](https://developer.android.com/tools/releases/platform-tools) — must be in `PATH` |
| **Android device** | Connected via USB or wireless ADB, USB debugging enabled |

## AI auto install

Show this repo to any AI agent powered by MCP — it can install and configure itself in one shot:

> "Clone https://github.com/CHENZHIJIE255/android-ui-inspector-mcp and run the setup"

The AI agent will:
1. Clone the repo
2. Run `npm install && npm run build && npm run setup`
3. The setup script registers the server in your MCP client config (e.g. `opencode.json`)
4. Server is ready to use — no manual steps

```bash
# Or do it yourself:
git clone https://github.com/CHENZHIJIE255/android-ui-inspector-mcp
cd android-ui-inspector-mcp
npm install && npm run build && npm run setup
```

After setup, the server is registered in `~/.config/opencode/opencode.json`:

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

## Tools

### `dump_view_tree`

Dump the full Android ViewTree XML hierarchy.

| Param | Type | Description |
|-------|------|-------------|
| `package_name` | `string` (optional) | Only include views from this package |
| `device_serial` | `string` (optional) | Target device serial (auto-selects if omitted) |
| `language` | `"en"` \| `"zh"` (optional) | Response language (auto-detected from env) |

### `find_views`

Find views matching criteria. All top-level conditions are ANDed together.

| Param | Type | Description |
|-------|------|-------------|
| `text` | `string \| string[]` | Exact text match (OR within array) |
| `text_contains` | `string \| string[]` | Case-insensitive substring (OR) |
| `text_regex` | `string` | Regular expression on text |
| `content_desc` | `string \| string[]` | Content description (OR) |
| `class_name` | `string \| string[]` | Class name, short or fully qualified (OR) |
| `resource_id` | `string \| string[]` | Resource ID (OR) |
| `package_name` | `string \| string[]` | Package name (OR) |
| `clickable` / `enabled` / `focused` / `checkable` / `checked` / `selected` / `scrollable` | `boolean` | State filters |
| `displayed` | `boolean` | Has non-zero bounds and is enabled |
| `has_text` / `has_content_desc` / `has_resource_id` | `boolean` | Non-empty field check |
| `$or` | `FindParams[]` | Cross-field OR — any sub-query satisfies; ANDed with top-level fields |
| `device_serial` | `string` (optional) | Target device serial |
| `language` | `"en"` \| `"zh"` (optional) | Response language |

Examples:

```json
// Find TextViews with text "hello" or "world"
{ "class_name": "android.widget.TextView", "text": ["hello", "world"] }

// Views that are clickable OR have class Button, AND contain "submit"
{ "text_contains": "submit", "$or": [{ "clickable": true }, { "class_name": "Button" }] }
```

### `list_debuggable_processes`

List Java processes available for JDWP debugging (`adb jdwp`).

| Param | Type | Description |
|-------|------|-------------|
| `device_serial` | `string` (optional) | Target device serial |
| `language` | `"en"` \| `"zh"` (optional) | Response language |

### `jdwp_connect`

Forward a local port to a debuggable process via JDWP.

| Param | Type | Description |
|-------|------|-------------|
| `pid` | `number` | Process ID |
| `port` | `number` (optional) | Local TCP port (default: 8700) |
| `device_serial` | `string` (optional) | Target device serial |
| `language` | `"en"` \| `"zh"` (optional) | Response language |

### `tree_summary`

Deep structural analysis of the view tree. Returns depth-by-depth breakdown, scrollable containers, class distribution, leaf vs container counts, and interactive element tallies.

| Param | Type | Description |
|-------|------|-------------|
| `device_serial` | `string` (optional) | Target device serial |
| `language` | `"en"` \| `"zh"` (optional) | Response language |

### `analyze_screen`

High-level screen understanding. Returns app info, screen type guess (form/list/settings/tabbed), navigation elements, text content summary, and an interactive summary.

| Param | Type | Description |
|-------|------|-------------|
| `device_serial` | `string` (optional) | Target device serial |
| `language` | `"en"` \| `"zh"` (optional) | Response language |

### `extract_text_content`

Extract ALL visible text from the current screen. Returns deduplicated text items with bounds, class_name, and resource_id.

| Param | Type | Description |
|-------|------|-------------|
| `device_serial` | `string` (optional) | Target device serial |
| `language` | `"en"` \| `"zh"` (optional) | Response language |

### `find_interactive`

Find ALL interactive UI elements grouped by type: clickable controls, scrollable containers, input/editable fields, and focusable elements. Every element includes full bounds, text, and resource_id.

| Param | Type | Description |
|-------|------|-------------|
| `device_serial` | `string` (optional) | Target device serial |
| `language` | `"en"` \| `"zh"` (optional) | Response language |

## i18n

English and Chinese supported. Set `"language": "zh"` in any call to get Chinese responses, or let the server auto-detect from `LC_MESSAGES` / `LANG`.

## Project structure

```
android-ui-inspector-mcp/
├── bin/
│   ├── setup.mjs           # Cross-platform setup
│   └── check-deps.mjs      # Postinstall dependency check
├── src/
│   ├── index.ts            # MCP server entry point
│   ├── adb.ts              # ADB device detection, shell, JDWP
│   ├── parser.ts           # uiautomator XML parser
│   ├── matcher.ts          # View tree filter
│   ├── i18n.ts             # Internationalization
│   └── types.ts            # Type definitions
├── dist/                   # Compiled JavaScript
├── README.md               # English docs
├── README.zh.md            # Chinese docs
├── package.json
└── tsconfig.json
```

## Development

```bash
npm run dev      # Watch mode
npm run build    # Compile TypeScript
npx tsc --noEmit # Type-check only
```

## License

MIT
