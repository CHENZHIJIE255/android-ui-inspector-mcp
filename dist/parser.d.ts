/**
 * uiautomator XML dump parser.
 * Converts the XML output of `uiautomator dump` into a typed view tree.
 * / uiautomator XML 解析器，将 `uiautomator dump` 的 XML 输出转为类型化的视图树。
 */
import { ViewNode, Bounds } from "./types.js";
/**
 * Parse uiautomator XML string into a structured ViewNode tree.
 * / 将 uiautomator XML 字符串解析为结构化的 ViewNode 树。
 */
export declare function parseViewTreeXml(xml: string): ViewNode[];
/**
 * Parse a bounds string like "[0,0][1080,2400]" into a {left, top, right, bottom, width, height} object.
 * / 将诸如 "[0,0][1080,2400]" 的边界字符串解析为结构化对象。
 */
export declare function parseBounds(boundsStr: string): Bounds;
/**
 * Flatten a tree of ViewNode into a flat array (DFS pre-order).
 * / 将 ViewNode 树展开为扁平数组（深度优先先序遍历）。
 */
export declare function flattenTree(nodes: ViewNode[]): ViewNode[];
