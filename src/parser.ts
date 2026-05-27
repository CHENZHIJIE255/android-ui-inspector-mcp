/**
 * uiautomator XML dump parser.
 * Converts the XML output of `uiautomator dump` into a typed view tree.
 * / uiautomator XML 解析器，将 `uiautomator dump` 的 XML 输出转为类型化的视图树。
 */

import { XMLParser } from "fast-xml-parser";
import { ViewNode, Bounds } from "./types.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  isArray: (name) => name === "node",
});

/**
 * Parse uiautomator XML string into a structured ViewNode tree.
 * / 将 uiautomator XML 字符串解析为结构化的 ViewNode 树。
 */
export function parseViewTreeXml(xml: string): ViewNode[] {
  const parsed = parser.parse(xml);
  const root = parsed?.hierarchy?.node;
  if (!root) return [];
  // Fast-xml-parser returns a single object for a singleton list
  // fast-xml-parser 对单元素列表返回单个对象而非数组
  const rootNodes = Array.isArray(root) ? root : [root];
  return rootNodes.map(n => parseNode(n));
}

/**
 * Parse a single XML node (recursive).
 * / 解析单个 XML 节点（递归）。
 *
 * NOTE: fast-xml-parser with attributeNamePrefix: "@_" stores attributes
 * directly on the xmlNode (e.g. xmlNode["@_class"]), NOT under an "@_" sub-object.
 * / 注意：fast-xml-parser 将属性直接存在 xmlNode 上（如 xmlNode["@_class"]），
 * 而不是嵌套在 @_ 子对象下。
 */
function parseNode(xmlNode: any): ViewNode {
  const a = xmlNode; // attributes are directly on xmlNode / 属性直接挂在 xmlNode 上
  const children: ViewNode[] = [];
  if (xmlNode.node) {
    const rawChildren = Array.isArray(xmlNode.node) ? xmlNode.node : [xmlNode.node];
    for (const child of rawChildren) {
      children.push(parseNode(child));
    }
  }

  return {
    index: parseInt(a["@_index"], 10) || 0,
    text: a["@_text"] || "",
    resource_id: a["@_resource-id"] || "",
    class_name: a["@_class"] || "",
    package_name: a["@_package"] || "",
    content_desc: a["@_content-desc"] || "",
    checkable: a["@_checkable"] === "true",
    checked: a["@_checked"] === "true",
    clickable: a["@_clickable"] === "true",
    enabled: a["@_enabled"] === "true",
    focusable: a["@_focusable"] === "true",
    focused: a["@_focused"] === "true",
    scrollable: a["@_scrollable"] === "true",
    long_clickable: a["@_long-clickable"] === "true",
    password: a["@_password"] === "true",
    selected: a["@_selected"] === "true",
    bounds: parseBounds(a["@_bounds"] || ""),
    children,
  };
}

/**
 * Parse a bounds string like "[0,0][1080,2400]" into a {left, top, right, bottom, width, height} object.
 * / 将诸如 "[0,0][1080,2400]" 的边界字符串解析为结构化对象。
 */
export function parseBounds(boundsStr: string): Bounds {
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
export function flattenTree(nodes: ViewNode[]): ViewNode[] {
  const result: ViewNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children && node.children.length > 0) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}
