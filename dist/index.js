#!/usr/bin/env node
/**
 * MCP server entry point for android-scope-mcp.
 * Registers view-tree, JDWP, memory inspection, tap, and correlate tools.
 */
import { execSync } from "child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, } from "@modelcontextprotocol/sdk/types.js";
import { dumpViewTreeXml, listDebuggableProcesses, forwardJdwp, removeForward, jdwpHandshake, getPackageName, ensureAdbAvailable } from "./adb.js";
import { parseViewTreeXml } from "./parser.js";
import { findViews } from "./matcher.js";
import { t, detectLocale } from "./i18n.js";
import { JdwpConnection } from "./jdwp.js";
import { ObjectInspector } from "./inspector.js";
const SERVER_NAME = "android-scope-mcp";
const SERVER_VERSION = "0.2.0";
const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
/**
 * Common device_serial parameter definition (shared across tools that need device targeting).
 * / 公共 device_serial 参数定义，各工具共用。
 */
const DEVICE_SERIAL_PARAM = {
    device_serial: {
        type: "string",
        description: "Target a specific device serial. Each call is independent — you can freely switch between different devices across calls without any disconnect/connect step. If omitted, auto-selects the first connected device. Use list_debuggable_processes to see available devices.",
    },
};
/**
 * Common language parameter definition (shared across tools that return messages).
 * / 公共 language 参数定义，各工具共用。
 */
const LANGUAGE_PARAM = {
    language: {
        type: "string",
        description: "Response language: en | zh. Auto-detected from env if omitted.",
    },
};
/**
 * Helper: generate a JSON schema that accepts a single string OR an array of strings,
 * guiding the LLM to use the right format.
 * / 生成 oneOf 模式：单个字符串或字符串数组，引导 LLM 使用正确的格式。
 */
function stringOrArraySchema(description) {
    return {
        oneOf: [
            { type: "string", description },
            { type: "array", items: { type: "string" }, description },
        ],
        description,
    };
}
/**
 * Resolve locale from user-provided value, env, or default.
 * / 从用户传入值、环境变量或默认值解析语言。
 */
function resolveLocale(language) {
    if (language === "zh")
        return "zh";
    if (language === "en")
        return "en";
    return detectLocale();
}
/**
 * JSON Schema for the find_views tool input.
 * / find_views 工具的输入 JSON Schema。
 */
const FIND_VIEWS_SCHEMA = {
    type: "object",
    properties: {
        text: stringOrArraySchema("Exact text to match (button label, input text). Single string or array (OR logic)."),
        text_contains: stringOrArraySchema("Case-insensitive substring match on text. Single string or array (OR logic)."),
        text_regex: { type: "string", description: "Regular expression match on text" },
        content_desc: stringOrArraySchema("Exact content description match. Single string or array (OR logic)."),
        class_name: stringOrArraySchema("View class name. Uses suffix matching — 'TextView' matches 'android.widget.TextView', 'View' matches all *View subclasses. Accepts short or full qualified name. Single string or array (OR logic)."),
        resource_id: stringOrArraySchema("Resource ID. Uses suffix matching — 'icon_title' matches 'com.example:id/icon_title'. Accepts full ID or short suffix. Single string or array (OR logic)."),
        package_name: stringOrArraySchema("Package name of the app, e.g. com.example.app. Single string or array (OR logic)."),
        clickable: { type: "boolean", description: "Filter by clickable state" },
        enabled: { type: "boolean", description: "Filter by enabled state" },
        focused: { type: "boolean", description: "Filter by focused state" },
        checkable: { type: "boolean", description: "Filter by checkable state" },
        checked: { type: "boolean", description: "Filter by checked state" },
        selected: { type: "boolean", description: "Filter by selected state" },
        scrollable: { type: "boolean", description: "Filter by scrollable state" },
        displayed: { type: "boolean", description: "Filter by whether the view has non-zero bounds and is enabled" },
        has_text: { type: "boolean", description: "Filter by whether the view has non-empty text" },
        has_content_desc: { type: "boolean", description: "Filter by whether the view has non-empty content description" },
        has_resource_id: { type: "boolean", description: "Filter by whether the view has non-empty resource ID" },
        $or: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    text: stringOrArraySchema("Exact text to match"),
                    text_contains: stringOrArraySchema("Case-insensitive substring match"),
                    text_regex: { type: "string", description: "Regular expression match" },
                    content_desc: stringOrArraySchema("Exact content description match"),
                    class_name: stringOrArraySchema("View class name (suffix matching)"),
                    resource_id: stringOrArraySchema("Resource ID (suffix matching)"),
                    package_name: stringOrArraySchema("Package name"),
                    clickable: { type: "boolean" },
                    enabled: { type: "boolean" },
                    focused: { type: "boolean" },
                    checkable: { type: "boolean" },
                    checked: { type: "boolean" },
                    selected: { type: "boolean" },
                    scrollable: { type: "boolean" },
                    displayed: { type: "boolean" },
                    has_text: { type: "boolean" },
                    has_content_desc: { type: "boolean" },
                    has_resource_id: { type: "boolean" },
                },
                additionalProperties: false,
            },
            description: "Cross-field OR. Array of sub-queries; if any matches, the condition is satisfied. Sub-queries use the same fields. ANDed with top-level fields.",
        },
        ...DEVICE_SERIAL_PARAM,
        ...LANGUAGE_PARAM,
    },
    additionalProperties: false,
};
/**
 * Register tool metadata (name, description, input schema).
 * / 注册工具元数据（名称、描述、输入参数定义）。
 */
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "dump_view_tree",
            description: "Get an overview of the current screen layout. Returns a compact summary (tree structure + class/state statistics) that is safe from truncation even on complex screens. Use this FIRST to understand the screen structure, then use find_views to query specific nodes with full attributes. Set detailed=true to return the full raw tree (WARNING: full tree can be >200KB on complex screens and may be silently truncated).",
            inputSchema: {
                type: "object",
                properties: {
                    package_name: stringOrArraySchema("Optional: filter summary to only include views from this package (single string or array for OR)."),
                    detailed: {
                        type: "boolean",
                        description: "If true, returns the FULL tree with ALL attributes for EVERY node. CAUTION: full tree can exceed 200KB on complex screens (e.g. launcher, web pages) and may be silently truncated by your MCP client — you won't know you missed nodes. Default: false (compact summary, always safe). Prefer summary mode + find_views for reliable access to full attributes.",
                    },
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                additionalProperties: false,
            },
        },
        {
            name: "find_views",
            description: "Query specific Android views by any combination of attributes. Use this to get FULL node attributes (text, bounds, resource_id, etc.) for the nodes you actually care about — unlike dump_view_tree which returns a compact overview. All conditions are ANDed. String fields accept arrays for OR. Use narrow filters to keep results small (results may truncate if > ~200 nodes). Example: find_views(clickable=true, has_text=true) to find buttons/links. Example: find_views(class_name='TextView') for text views. NOTE: class_name and resource_id use suffix matching — 'TextView' matches 'android.widget.TextView', 'icon_title' matches 'com.example:id/icon_title'.",
            inputSchema: FIND_VIEWS_SCHEMA,
        },
        {
            name: "list_debuggable_processes",
            description: "List debuggable processes on the device via JDWP / adb jdwp. Returns PIDs and package names of apps that have debugging enabled.",
            inputSchema: {
                type: "object",
                properties: {
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                additionalProperties: false,
            },
        },
        {
            name: "jdwp_connect",
            description: "Forward a local port to a debuggable process via JDWP. Returns success/failure of the JDWP handshake. This allows deeper inspection of the app's live View objects.",
            inputSchema: {
                type: "object",
                properties: {
                    pid: { type: "number", description: "Process ID of the debuggable app" },
                    port: { type: "number", description: "Optional: local TCP port to forward (default: 8700)." },
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                required: ["pid"],
                additionalProperties: false,
            },
        },
        {
            name: "tree_summary",
            description: "Deep structural analysis of the view tree. Returns depth-by-depth breakdown, scrollable containers (RecyclerView/ScrollView/ListView), class distribution, leaf vs container counts, and interactive element tallies. Unlike dump_view_tree's compact overview, this gives a thorough structural picture with per-level detail.",
            inputSchema: {
                type: "object",
                properties: {
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                additionalProperties: false,
            },
        },
        {
            name: "analyze_screen",
            description: "Comprehensive high-level screen analysis. Returns app info, screen type guess (form/list/settings/tabbed/etc), navigation elements (top bar, bottom nav), text content summary, input fields and clickable elements counts, and a plain-english interactive summary. Use this to quickly understand WHAT a screen is about before drilling into details.",
            inputSchema: {
                type: "object",
                properties: {
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                additionalProperties: false,
            },
        },
        {
            name: "extract_text_content",
            description: "Extract ALL visible text from the current screen. Returns deduplicated text items with bounds, class_name, and resource_id. Unlike dump_view_tree which shows text inline in the tree structure, this gives a clean flat list focused purely on text content — ideal for understanding what information is displayed.",
            inputSchema: {
                type: "object",
                properties: {
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                additionalProperties: false,
            },
        },
        {
            name: "find_interactive",
            description: "Find ALL interactive UI elements on screen, grouped by interaction type. Returns separate lists for: clickable controls (buttons, links, icons), scrollable containers, input/editable fields, and focusable elements. Every element includes full bounds, text, and resource_id. Use this to understand what the user can actually interact with.",
            inputSchema: {
                type: "object",
                properties: {
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                additionalProperties: false,
            },
        },
        {
            name: "inspect_object",
            description: "Read runtime memory from a debuggable Android app via JDWP path expression. Temporarily suspends the app (typically <100ms), resolves a dot-notation path, and resumes. Path examples: 'mViewModel.mDataList[0].title', 'mTitle', 'mDecorView.mFocused.mText'. Start with just the class name and empty path to see all top-level fields. Returns structured JSON with field names, values, and types.",
            inputSchema: {
                type: "object",
                properties: {
                    pid: { type: "number", description: "Process ID of the debuggable app (from list_debuggable_processes)" },
                    class_name: { type: "string", description: "Full class name to inspect, e.g. com.example.test.MainActivity" },
                    path: { type: "string", description: "Optional dot-notation field path, e.g. 'mViewModel.mDataList[0].title'. Empty string returns all top-level fields." },
                    max_depth: { type: "number", description: "Max recursion depth for nested objects (default: 8)" },
                    port: { type: "number", description: "Optional local port for JDWP forwarding (default: 8701)" },
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                required: ["pid", "class_name"],
                additionalProperties: false,
            },
        },
        {
            name: "tap",
            description: "Simulate a tap/click on the Android device at the specified coordinates. Use after find_views or analyze_screen to get coordinates from view bounds. Example: tap(x=540, y=1200) to click the center of a button.",
            inputSchema: {
                type: "object",
                properties: {
                    x: { type: "number", description: "X coordinate to tap" },
                    y: { type: "number", description: "Y coordinate to tap" },
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                required: ["x", "y"],
                additionalProperties: false,
            },
        },
        {
            name: "snapshot",
            description: "Take a timed memory snapshot of a debuggable app. Connects to JDWP, suspends the VM, reads ALL fields of the specified class instance, then resumes. Accepts an optional interval_seconds for repeated polling (compares with previous snapshot and only returns differences). Combine with dump_view_tree for view-data correlation.",
            inputSchema: {
                type: "object",
                properties: {
                    pid: { type: "number", description: "Process ID of the debuggable app" },
                    class_name: { type: "string", description: "Full class name to snapshot, e.g. com.example.test.MainActivity" },
                    path: { type: "string", description: "Optional field path to narrow the snapshot. Empty returns all fields." },
                    interval_seconds: { type: "number", description: "Optional: poll continuously at this interval. Each poll compares with previous and returns only changed fields." },
                    count: { type: "number", description: "Number of snapshots to take when polling (default: 3)" },
                    port: { type: "number", description: "Optional local port for JDWP forwarding (default: 8701)" },
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                required: ["pid", "class_name"],
                additionalProperties: false,
            },
        },
        {
            name: "correlate",
            description: "View-Data correlation: dumps the view tree AND reads runtime memory from the debugged app in a single operation. Returns both UI structure and backing data so you can compare what the screen shows vs what the app's data model contains. Ideal for detecting data/display mismatches.",
            inputSchema: {
                type: "object",
                properties: {
                    pid: { type: "number", description: "Process ID of the debuggable app" },
                    class_name: { type: "string", description: "Full class name of the Activity/ViewModel to inspect" },
                    ui_path: { type: "string", description: "Optional package filter for the view tree dump" },
                    data_path: { type: "string", description: "Optional field path for the data snapshot" },
                    port: { type: "number", description: "Optional local port for JDWP forwarding (default: 8701)" },
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                required: ["pid", "class_name"],
                additionalProperties: false,
            },
        },
    ],
}));
function summarizeTree(roots) {
    let totalNodes = 0;
    let maxDepth = 0;
    const classCount = {};
    const stats = {
        clickable: 0, enabled: 0, scrollable: 0,
        has_text: 0, has_content_desc: 0, has_resource_id: 0,
    };
    const apps = new Set();
    let screenRes = "";
    // First pass: count ALL nodes (full traversal without truncation)
    // / 第一遍：完整遍历全部节点，精确统计
    function countAll(nodes, depth) {
        for (const n of nodes) {
            totalNodes++;
            maxDepth = Math.max(maxDepth, depth);
            classCount[n.class_name] = (classCount[n.class_name] || 0) + 1;
            if (n.clickable)
                stats.clickable++;
            if (n.enabled)
                stats.enabled++;
            if (n.scrollable)
                stats.scrollable++;
            if (n.text)
                stats.has_text++;
            if (n.content_desc)
                stats.has_content_desc++;
            if (n.resource_id)
                stats.has_resource_id++;
            if (n.package_name)
                apps.add(n.package_name);
            if (depth === 0)
                screenRes = `${n.bounds.width}x${n.bounds.height}`;
            if (n.children)
                countAll(n.children, depth + 1);
        }
    }
    countAll(roots, 0);
    // Second pass: build compact tree lines (truncated for readability)
    // / 第二遍：生成紧凑树形展示（适当截断避免过长）
    const treeLines = [];
    const MAX_TREE_LINES = 40;
    function buildTree(nodes, depth, prefix) {
        for (let i = 0; i < nodes.length; i++) {
            if (treeLines.length >= MAX_TREE_LINES)
                return;
            const n = nodes[i];
            const rid = n.resource_id ? ` (${n.resource_id})` : "";
            const info = n.text ? ` text="${n.text.slice(0, 30)}"` : "";
            treeLines.push(`${prefix}${n.class_name}${rid}${info}`);
            if (n.children?.length) {
                const shown = n.children.slice(0, 3);
                buildTree(shown, depth + 1, prefix + "  ");
                if (treeLines.length >= MAX_TREE_LINES)
                    return;
                if (n.children.length > 3) {
                    treeLines.push(`${prefix}  ... (${n.children.length - 3} more)`);
                }
            }
        }
    }
    buildTree(roots, 0, "");
    return {
        app: apps.size === 1 ? [...apps][0] : apps.size > 1 ? `${apps.size} apps` : "(none)",
        screen_resolution: screenRes,
        total_nodes: totalNodes,
        max_depth: maxDepth,
        elapsed_ms: 0,
        class_summary: classCount,
        stats,
        tree: treeLines,
    };
}
function buildTreeBreakdown(roots) {
    let totalNodes = 0;
    let maxDepth = 0;
    const classCount = {};
    const depthMap = {};
    let leaves = 0;
    let containers = 0;
    let clickable = 0;
    let scrollable = 0;
    let focusable = 0;
    let editable = 0;
    const apps = new Set();
    let screenRes = "";
    const scrollContainers = [];
    function walk(nodes, depth) {
        for (const n of nodes) {
            totalNodes++;
            maxDepth = Math.max(maxDepth, depth);
            if (!depthMap[depth]) {
                depthMap[depth] = { node_count: 0, classes: {} };
            }
            depthMap[depth].node_count++;
            depthMap[depth].classes[n.class_name] = (depthMap[depth].classes[n.class_name] || 0) + 1;
            classCount[n.class_name] = (classCount[n.class_name] || 0) + 1;
            if (n.clickable)
                clickable++;
            if (n.scrollable)
                scrollable++;
            if (n.focusable)
                focusable++;
            if (n.class_name.includes("EditText") || n.class_name.includes("Editor"))
                editable++;
            if (n.package_name)
                apps.add(n.package_name);
            if (depth === 0)
                screenRes = `${n.bounds.width}x${n.bounds.height}`;
            if (n.children && n.children.length > 0) {
                containers++;
                // Detect scrollable containers (RecyclerView, ScrollView, ListView, etc.)
                const cn = n.class_name.toLowerCase();
                if (n.scrollable || cn.includes("scrollview") || cn.includes("recyclerview") || cn.includes("listview")) {
                    scrollContainers.push({
                        class: n.class_name,
                        resource_id: n.resource_id,
                        children_count: countAllDescendants(n) - 1,
                        bounds: n.bounds,
                    });
                }
                walk(n.children, depth + 1);
            }
            else {
                leaves++;
            }
        }
    }
    walk(roots, 0);
    return {
        app: apps.size === 1 ? [...apps][0] : apps.size > 1 ? `${apps.size} apps` : "(none)",
        screen_resolution: screenRes,
        total_nodes: totalNodes,
        max_depth: maxDepth,
        depth_breakdown: depthMap,
        class_summary: classCount,
        leaf_vs_container: { leaves, containers },
        interactive_count: { clickable, scrollable, focusable, editable },
        scrollable_containers: scrollContainers,
    };
}
function countAllDescendants(node) {
    let count = 1;
    for (const child of node.children || []) {
        count += countAllDescendants(child);
    }
    return count;
}
function extractAllText(roots) {
    const result = [];
    const seen = new Set();
    function walk(nodes) {
        for (const n of nodes) {
            const text = n.text?.trim() || n.content_desc?.trim();
            if (text) {
                const key = `${text}|${n.bounds.left}|${n.bounds.top}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    result.push({
                        text,
                        resource_id: n.resource_id,
                        class_name: n.class_name,
                        bounds: n.bounds,
                    });
                }
            }
            if (n.children)
                walk(n.children);
        }
    }
    walk(roots);
    return result;
}
function findInteractiveElements(roots) {
    const clickable = [];
    const scrollable = [];
    const inputFields = [];
    const focusable = [];
    const seenClickable = new Set();
    const seenScrollable = new Set();
    const seenInput = new Set();
    const seenFocusable = new Set();
    function walk(nodes) {
        for (const n of nodes) {
            // Clickable — take top-most clickable (skip children of clickable parents)
            // / 可点击元素 — 取最外层的，跳过可点击父节点内部的子节点
            if (n.clickable && !n.class_name.includes("ViewGroup") && !n.class_name.includes("Layout")) {
                const key = n.resource_id || `${n.class_name}|${n.bounds.left}|${n.bounds.top}`;
                if (!seenClickable.has(key)) {
                    seenClickable.add(key);
                    clickable.push({
                        text: n.text || "",
                        content_desc: n.content_desc || "",
                        class_name: n.class_name,
                        resource_id: n.resource_id,
                        bounds: n.bounds,
                        enabled: n.enabled,
                    });
                }
            }
            // Input fields / 输入框
            if (n.class_name.includes("EditText") || n.class_name === "android.widget.EditText") {
                const key = `${n.bounds.left}|${n.bounds.top}`;
                if (!seenInput.has(key)) {
                    seenInput.add(key);
                    inputFields.push({
                        text: n.text || "",
                        hint: n.content_desc || "",
                        class_name: n.class_name,
                        resource_id: n.resource_id,
                        bounds: n.bounds,
                        enabled: n.enabled,
                        focused: n.focused,
                    });
                }
            }
            // Focusable (non-input)
            if (n.focusable && !n.class_name.includes("EditText")) {
                const key = `${n.class_name}|${n.bounds.left}|${n.bounds.top}`;
                if (!seenFocusable.has(key)) {
                    seenFocusable.add(key);
                    focusable.push({
                        text: n.text || "",
                        content_desc: n.content_desc || "",
                        class_name: n.class_name,
                        resource_id: n.resource_id,
                        bounds: n.bounds,
                    });
                }
            }
            if (n.children)
                walk(n.children);
        }
    }
    walk(roots);
    // Scrollable containers: collect from tree walk
    // / 可滚动容器：从整树收集
    function collectScrollable(nodes) {
        for (const n of nodes) {
            const cn = n.class_name.toLowerCase();
            const isScrollContainer = n.scrollable
                || cn.includes("scrollview")
                || cn.includes("recyclerview")
                || cn.includes("listview")
                || cn.includes("viewpager");
            if (isScrollContainer) {
                const key = n.resource_id || `${n.class_name}|${n.bounds.left}|${n.bounds.top}`;
                if (!seenScrollable.has(key)) {
                    seenScrollable.add(key);
                    scrollable.push({
                        text: n.text || "",
                        class_name: n.class_name,
                        resource_id: n.resource_id,
                        bounds: n.bounds,
                        children_count: countAllDescendants(n) - 1,
                    });
                }
            }
            if (n.children)
                collectScrollable(n.children);
        }
    }
    collectScrollable(roots);
    return { clickable, scrollable, input_fields: inputFields, focusable };
}
/** Determine screen type from tree structure / 从树结构推断屏幕类型。 */
function guessScreenType(roots, flatTexts) {
    const flatList = flatTexts.join(" ").toLowerCase();
    const classNames = new Set();
    function collectClasses(nodes) {
        for (const n of nodes) {
            classNames.add(n.class_name);
            if (n.children)
                collectClasses(n.children);
        }
    }
    collectClasses(roots);
    const hasListView = classNames.has("android.widget.ListView") || classNames.has("androidx.recyclerview.widget.RecyclerView");
    const hasGridView = classNames.has("android.widget.GridView");
    const hasWebView = classNames.has("android.webkit.WebView");
    const hasMap = classNames.has("com.google.android.gms.maps.MapView") || classNames.has("MapView");
    const hasEditText = [...classNames].some(c => c.includes("EditText"));
    const hasSpinner = [...classNames].some(c => c.includes("Spinner"));
    const hasCheckBox = [...classNames].some(c => c.includes("CheckBox") || c.includes("Switch"));
    const hasTabWidget = [...classNames].some(c => c.includes("TabWidget") || c.includes("TabLayout"));
    const hasBottomNav = [...classNames].some(c => c.includes("BottomNavigation"));
    const hints = [];
    if (hasEditText && hasListView)
        hints.push("search_or_list");
    else if (hasEditText && flatTexts.length < 10)
        hints.push("form");
    else if (hasWebView)
        hints.push("web_view");
    else if (hasMap)
        hints.push("map");
    else if (hasListView && flatTexts.length > 10)
        hints.push("list");
    else if (hasGridView)
        hints.push("grid");
    else if (hasSpinner && hasCheckBox)
        hints.push("settings_filter");
    else if (hasTabWidget || hasBottomNav)
        hints.push("tabbed");
    return hints.length > 0 ? hints.join("/") : "generic";
}
function analyzeScreen(roots) {
    const apps = new Set();
    let screenRes = "";
    let totalNodes = 0;
    let hasScrollableContent = false;
    const topBarElements = [];
    const bottomNavElements = [];
    const texts = [];
    let inputCount = 0;
    let clickableCount = 0;
    function walk(nodes, depth) {
        for (const n of nodes) {
            totalNodes++;
            if (n.package_name)
                apps.add(n.package_name);
            if (depth === 0)
                screenRes = `${n.bounds.width}x${n.bounds.height}`;
            const rid = n.resource_id || "";
            const cn = n.class_name.toLowerCase();
            // Top bar detection (near top of screen, likely title bar / toolbar)
            if (depth <= 3 && n.bounds.top < 200 && (n.text || n.content_desc)) {
                topBarElements.push({
                    text: n.text || n.content_desc || "",
                    resource_id: rid,
                });
            }
            // Bottom navigation detection
            if (cn.includes("bottomnavigation") || cn.includes("tab")) {
                if (n.text) {
                    bottomNavElements.push({ text: n.text, resource_id: rid });
                }
            }
            if (n.text?.trim())
                texts.push(n.text.trim());
            if (n.content_desc?.trim())
                texts.push(n.content_desc.trim());
            if (n.class_name.includes("EditText"))
                inputCount++;
            if (n.clickable)
                clickableCount++;
            if (n.scrollable || cn.includes("scrollview") || cn.includes("recyclerview"))
                hasScrollableContent = true;
            if (n.children)
                walk(n.children, depth + 1);
        }
    }
    walk(roots, 0);
    const screenType = guessScreenType(roots, texts);
    const uniqueTexts = [...new Set(texts)];
    return {
        app: apps.size === 1 ? [...apps][0] : apps.size > 1 ? `${apps.size} apps` : "(none)",
        screen_resolution: screenRes,
        screen_type: screenType,
        total_nodes: totalNodes,
        text_content: uniqueTexts.slice(0, 50), // cap at 50 texts for concise summary
        navigation: {
            top_bar: topBarElements.slice(0, 5),
            bottom_nav: bottomNavElements,
        },
        content_area: {
            has_scrollable_content: hasScrollableContent,
            input_fields_count: inputCount,
            clickable_elements_count: clickableCount,
        },
        interactive_summary: [
            inputCount > 0 ? `${inputCount} input field(s)` : null,
            clickableCount > 0 ? `${clickableCount} clickable element(s)` : null,
            hasScrollableContent ? "scrollable content" : null,
            uniqueTexts.length > 0 ? `${uniqueTexts.length} text item(s)` : null,
        ].filter(Boolean).join(", "),
    };
}
/**
 * Core query pipeline: dump view tree XML -> parse -> filter by params.
 * / 核心查询流水线：导出视图树 XML -> 解析 -> 按参数筛选。
 */
async function queryViewTree(params, deviceSerial, locale) {
    const lang = locale ?? detectLocale();
    const start = Date.now();
    try {
        const xml = dumpViewTreeXml(deviceSerial);
        const roots = parseViewTreeXml(xml);
        if (roots.length === 0) {
            return {
                nodes: [],
                total_count: 0,
                elapsed_ms: Date.now() - start,
                error: t(lang, "viewtree.no_root"),
            };
        }
        const nodes = Object.keys(params).length > 0 && params.constructor === Object
            ? findViews(roots, params)
            : roots;
        return {
            nodes,
            total_count: nodes.length,
            elapsed_ms: Date.now() - start,
        };
    }
    catch (e) {
        return {
            nodes: [],
            total_count: 0,
            elapsed_ms: Date.now() - start,
            error: e instanceof Error ? e.message : String(e),
        };
    }
}
/**
 * Handle incoming tool call requests.
 * / 处理传入的工具调用请求。
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    switch (name) {
        case "dump_view_tree": {
            const dumpArgs = (args ?? {});
            const pkgFilter = dumpArgs.package_name;
            const dumpSerial = dumpArgs.device_serial;
            const lang = resolveLocale(dumpArgs.language);
            const params = {};
            if (pkgFilter)
                params.package_name = pkgFilter;
            if (dumpSerial)
                params.device_serial = dumpSerial;
            // Always fetch full tree for summary (filter applied in summary if package_name given)
            const start = Date.now();
            const xml = dumpViewTreeXml(dumpSerial);
            const roots = parseViewTreeXml(xml);
            if (roots.length === 0) {
                return { content: [{ type: "text", text: JSON.stringify({ error: t(lang, "viewtree.no_root") }) }] };
            }
            const filtered = pkgFilter
                ? findViews(roots, { package_name: pkgFilter })
                : roots;
            if (dumpArgs.detailed === true) {
                // Full tree mode (liable to truncation on complex screens)
                const result = { nodes: filtered, total_count: filtered.length, elapsed_ms: Date.now() - start };
                return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
            }
            // Summary mode (default) — compact, AI-friendly, never truncated
            const summary = summarizeTree(filtered);
            summary.elapsed_ms = Date.now() - start;
            return {
                content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
            };
        }
        case "find_views": {
            const findArgs = (args ?? {});
            const findSerial = findArgs.device_serial;
            const lang = resolveLocale(findArgs.language);
            const params = findArgs;
            if (params.device_serial)
                delete params.device_serial;
            if (params.language)
                delete params.language;
            const result = await queryViewTree(params, findSerial, lang);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        case "list_debuggable_processes": {
            try {
                const listArgs = (args ?? {});
                const listSerial = listArgs.device_serial;
                const processes = await listDebuggableProcesses(listSerial);
                return {
                    content: [{ type: "text", text: JSON.stringify(processes, null, 2) }],
                };
            }
            catch (e) {
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }, null, 2) }],
                    isError: true,
                };
            }
        }
        case "jdwp_connect": {
            const jdwpArgs = (args ?? {});
            const { pid, port } = jdwpArgs;
            const jdwpSerial = jdwpArgs.device_serial;
            const lang = resolveLocale(jdwpArgs.language);
            try {
                const { serial, localPort } = forwardJdwp(jdwpSerial, port ?? 8700, pid);
                const handshakeOk = await jdwpHandshake(localPort);
                if (!handshakeOk) {
                    removeForward(serial, localPort);
                    throw new Error(t(lang, "jdwp.handshake_failed"));
                }
                const pkg = getPackageName(serial, pid);
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                success: true,
                                pid,
                                package_name: pkg ?? "unknown",
                                local_port: localPort,
                                message: `JDWP handshake successful. Use jdb or any JDWP client on localhost:${localPort} / JDWP 握手成功，可在 localhost:${localPort} 连接`,
                            }, null, 2),
                        },
                    ],
                };
            }
            catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: "text", text: JSON.stringify({ success: false, error: msg }, null, 2) }],
                    isError: true,
                };
            }
        }
        case "tree_summary":
        case "analyze_screen":
        case "extract_text_content":
        case "find_interactive": {
            const analysisArgs = (args ?? {});
            const analysisSerial = analysisArgs.device_serial;
            const lang = resolveLocale(analysisArgs.language);
            const start = Date.now();
            let xml;
            try {
                xml = dumpViewTreeXml(analysisSerial);
            }
            catch (e) {
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }],
                    isError: true,
                };
            }
            const roots = parseViewTreeXml(xml);
            if (roots.length === 0) {
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: t(lang, "viewtree.no_root") }) }],
                    isError: true,
                };
            }
            let result;
            switch (name) {
                case "tree_summary": {
                    const breakdown = buildTreeBreakdown(roots);
                    result = { ...breakdown, elapsed_ms: Date.now() - start };
                    break;
                }
                case "analyze_screen": {
                    const analysis = analyzeScreen(roots);
                    result = { ...analysis, elapsed_ms: Date.now() - start };
                    break;
                }
                case "extract_text_content": {
                    const texts = extractAllText(roots);
                    result = {
                        app: roots[0]?.package_name || "",
                        screen_resolution: `${roots[0]?.bounds.width}x${roots[0]?.bounds.height}`,
                        total_text_items: texts.length,
                        items: texts,
                        elapsed_ms: Date.now() - start,
                    };
                    break;
                }
                case "find_interactive": {
                    const interactive = findInteractiveElements(roots);
                    const total = interactive.clickable.length +
                        interactive.scrollable.length +
                        interactive.input_fields.length +
                        interactive.focusable.length;
                    result = {
                        total_interactive: total,
                        ...interactive,
                        elapsed_ms: Date.now() - start,
                    };
                    break;
                }
                default:
                    throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
            }
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        // ── Memory inspection tools ──
        case "inspect_object":
        case "snapshot": {
            const inspArgs = (args ?? {});
            const pid = inspArgs.pid;
            const className = inspArgs.class_name;
            const path = inspArgs.path || "";
            const inspPort = inspArgs.port || 8701;
            const maxDepth = inspArgs.max_depth || 8;
            const intervalSecs = inspArgs.interval_seconds;
            const snapshotCount = inspArgs.count || 3;
            const lang = resolveLocale(inspArgs.language);
            const inspSerial = inspArgs.device_serial;
            const results = [];
            const maxSnapshots = name === "snapshot" && intervalSecs ? snapshotCount : 1;
            for (let snapIdx = 0; snapIdx < maxSnapshots; snapIdx++) {
                let conn = null;
                const localPort = inspPort + snapIdx;
                try {
                    const { serial } = forwardJdwp(inspSerial, localPort, pid);
                    conn = new JdwpConnection();
                    await conn.connect(localPort);
                    const inspector = new ObjectInspector(conn, maxDepth);
                    const result = await inspector.snapshot(className, path);
                    results.push({
                        snapshot_index: snapIdx,
                        ...result,
                    });
                    conn.disconnect();
                    removeForward(serial, localPort);
                }
                catch (e) {
                    if (conn)
                        try {
                            conn.disconnect();
                        }
                        catch { }
                    try {
                        removeForward(ensureAdbAvailable(inspSerial), localPort);
                    }
                    catch { }
                    results.push({
                        snapshot_index: snapIdx,
                        error: e instanceof Error ? e.message : String(e),
                    });
                    break;
                }
                if (snapIdx < maxSnapshots - 1 && intervalSecs) {
                    await new Promise(r => setTimeout(r, intervalSecs * 1000));
                }
            }
            return {
                content: [{ type: "text", text: JSON.stringify(results.length === 1 ? results[0] : results, null, 2) }],
            };
        }
        case "tap": {
            const tapArgs = (args ?? {});
            const x = tapArgs.x;
            const y = tapArgs.y;
            const tapSerial = tapArgs.device_serial;
            try {
                const serial = ensureAdbAvailable(tapSerial);
                execSync(`adb -s ${serial} shell input tap ${x} ${y}`, { encoding: "utf-8" });
                return {
                    content: [{ type: "text", text: JSON.stringify({ success: true, x, y }) }],
                };
            }
            catch (e) {
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }],
                    isError: true,
                };
            }
        }
        case "correlate": {
            const corrArgs = (args ?? {});
            const corrPid = corrArgs.pid;
            const corrClassName = corrArgs.class_name;
            const uiFilter = corrArgs.ui_path;
            const dataPath = corrArgs.data_path || "";
            const corrPort = corrArgs.port || 8701;
            const corrSerial = corrArgs.device_serial;
            const lang = resolveLocale(corrArgs.language);
            const result = {};
            // 1. Dump view tree
            try {
                const xml = dumpViewTreeXml(corrSerial);
                const roots = parseViewTreeXml(xml);
                const filtered = uiFilter
                    ? findViews(roots, { package_name: uiFilter })
                    : roots;
                result.ui = {
                    total_nodes: filtered.length,
                    tree: filtered.slice(0, 100).map(n => ({
                        class: n.class_name,
                        text: n.text?.slice(0, 80),
                        resource_id: n.resource_id,
                        bounds: n.bounds,
                    })),
                };
            }
            catch (e) {
                result.ui = { error: e instanceof Error ? e.message : String(e) };
            }
            // 2. Read memory
            let conn = null;
            try {
                const { serial } = forwardJdwp(corrSerial, corrPort, corrPid);
                conn = new JdwpConnection();
                await conn.connect(corrPort);
                const inspector = new ObjectInspector(conn);
                const snapshot = await inspector.snapshot(corrClassName, dataPath);
                result.memory = snapshot;
                conn.disconnect();
                removeForward(serial, corrPort);
            }
            catch (e) {
                if (conn)
                    try {
                        conn.disconnect();
                    }
                    catch { }
                try {
                    removeForward(ensureAdbAvailable(corrSerial), corrPort);
                }
                catch { }
                result.memory = { error: e instanceof Error ? e.message : String(e) };
            }
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            };
        }
        default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
});
/**
 * Start the server on stdio transport.
 * / 在 stdio 传输层上启动服务器。
 */
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // eslint-disable-next-line no-console
    console.error(`${SERVER_NAME} v${SERVER_VERSION} running on stdio`);
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map