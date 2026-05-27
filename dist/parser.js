/**
 * uiautomator XML dump parser.
 * Converts the XML output of `uiautomator dump` into a typed view tree.
 * / uiautomator XML 解析器，将 `uiautomator dump` 的 XML 输出转为类型化的视图树。
 */
import { XMLParser } from "fast-xml-parser";
const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    isArray: (name) => name === "node",
});
/**
 * Parse uiautomator XML string into a structured ViewNode tree.
 * / 将 uiautomator XML 字符串解析为结构化的 ViewNode 树。
 */
export function parseViewTreeXml(xml) {
    const parsed = parser.parse(xml);
    const root = parsed?.hierarchy?.node;
    if (!root)
        return [];
    // Fast-xml-parser returns a single object for a singleton list
    // fast-xml-parser 对单元素列表返回单个对象而非数组
    const rootNodes = Array.isArray(root) ? root : [root];
    return rootNodes.map(n => parseNode(n));
}
/**
 * Parse a single XML node (recursive).
 * / 解析单个 XML 节点（递归）。
 */
function parseNode(xmlNode) {
    const attrs = xmlNode["@_"] || {};
    const children = [];
    if (xmlNode.node) {
        const rawChildren = Array.isArray(xmlNode.node) ? xmlNode.node : [xmlNode.node];
        for (const child of rawChildren) {
            children.push(parseNode(child));
        }
    }
    return {
        index: parseInt(attrs["@_index"], 10) || 0,
        text: attrs["@_text"] || "",
        resource_id: attrs["@_resource-id"] || "",
        class_name: attrs["@_class"] || "",
        package_name: attrs["@_package"] || "",
        content_desc: attrs["@_content-desc"] || "",
        checkable: attrs["@_checkable"] === "true",
        checked: attrs["@_checked"] === "true",
        clickable: attrs["@_clickable"] === "true",
        enabled: attrs["@_enabled"] === "true",
        focusable: attrs["@_focusable"] === "true",
        focused: attrs["@_focused"] === "true",
        scrollable: attrs["@_scrollable"] === "true",
        long_clickable: attrs["@_long-clickable"] === "true",
        password: attrs["@_password"] === "true",
        selected: attrs["@_selected"] === "true",
        bounds: parseBounds(attrs["@_bounds"] || ""),
        children,
    };
}
/**
 * Parse a bounds string like "[0,0][1080,2400]" into a {left, top, right, bottom, width, height} object.
 * / 将诸如 "[0,0][1080,2400]" 的边界字符串解析为结构化对象。
 */
export function parseBounds(boundsStr) {
    const match = boundsStr.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!match) {
        return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    const left = parseInt(match[1], 10);
    const top = parseInt(match[2], 10);
    const right = parseInt(match[3], 10);
    const bottom = parseInt(match[4], 10);
    return {
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
    };
}
/**
 * Flatten a tree of ViewNode into a flat array (DFS pre-order).
 * / 将 ViewNode 树展开为扁平数组（深度优先先序遍历）。
 */
export function flattenTree(nodes) {
    const result = [];
    for (const node of nodes) {
        result.push(node);
        if (node.children && node.children.length > 0) {
            result.push(...flattenTree(node.children));
        }
    }
    return result;
}
//# sourceMappingURL=parser.js.map