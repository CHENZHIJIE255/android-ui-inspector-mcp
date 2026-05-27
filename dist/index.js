#!/usr/bin/env node
/**
 * MCP server entry point for android-viewtree-mcp.
 * Defines 4 tools: dump_view_tree, find_views, list_debuggable_processes, jdwp_connect.
 * / MCP 服务器入口。注册 dump_view_tree、find_views、list_debuggable_processes、jdwp_connect 四个工具。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode, } from "@modelcontextprotocol/sdk/types.js";
import { dumpViewTreeXml, listDebuggableProcesses, forwardJdwp, removeForward, jdwpHandshake, getPackageName } from "./adb.js";
import { parseViewTreeXml } from "./parser.js";
import { findViews } from "./matcher.js";
import { t, detectLocale } from "./i18n.js";
const SERVER_NAME = "android-ui-inspector-mcp";
const SERVER_VERSION = "0.1.0";
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
        class_name: stringOrArraySchema("View class name, e.g. Button, TextView, ImageView. Accepts short or full qualified name. Single string or array (OR logic)."),
        resource_id: stringOrArraySchema("Resource ID, e.g. com.example:id/btn_login, or just btn_login. Single string or array (OR logic)."),
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
                    class_name: stringOrArraySchema("View class name"),
                    resource_id: stringOrArraySchema("Resource ID"),
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
            description: "Dump the current Android ViewTree hierarchy via uiautomator. Returns full tree with all attributes (text, bounds, clickable, etc.).",
            inputSchema: {
                type: "object",
                properties: {
                    package_name: {
                        type: "string",
                        description: "Optional: filter results to only include views from this package.",
                    },
                    ...DEVICE_SERIAL_PARAM,
                    ...LANGUAGE_PARAM,
                },
                additionalProperties: false,
            },
        },
        {
            name: "find_views",
            description: "Find Android views matching criteria. All specified conditions are ANDed together. Returns matching views with full attributes. Example: find(text='login', clickable=true) returns clickable buttons with text 'login'.",
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
    ],
}));
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
            const result = await queryViewTree(params, dumpSerial, lang);
            return {
                content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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