/**
 * View finder: filter a view tree by field-value criteria.
 * / 视图查找器：按字段值条件过滤视图树。
 */

import { ViewNode, FindParams } from "./types.js";

/**
 * Recursively search the view tree for nodes matching the given filter criteria.
 * Returns all matching nodes (from any depth) in document order.
 * / 递归搜索视图树，返回所有匹配的节点（任何深度），按文档顺序排列。
 */
export function findViews(nodes: ViewNode[], params: FindParams, path = ""): ViewNode[] {
  const result: ViewNode[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const nodePath = path ? `${path} > ${node.class_name}[${i}]` : `${node.class_name}[${i}]`;

    if (matches(node, params)) {
      result.push(node);
    }

    if (node.children && node.children.length > 0) {
      const childResults = findViews(node.children, params, nodePath);
      result.push(...childResults);
    }
  }

  return result;
}

/** Convert a value to an array for uniform handling. / 统一将值转为数组方便处理。 */
function toArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined) return [];
  return Array.isArray(val) ? val : [val];
}

/**
 * Check whether a single node matches all criteria in the filter.
 * All top-level criteria (except $or) are ANDed together.
 * $or is also ANDed with top-level fields — node must match both
 * the top-level conditions AND at least one $or sub-query.
 * / 检查单个节点是否满足所有过滤条件。
 * 顶层字段之间为 AND 关系，与 $or 子查询之间也是 AND 关系。
 */
function matches(node: ViewNode, params: FindParams): boolean {
  // If `displayed` is explicitly requested, check non-zero bounds + enabled
  // 如果指定了 displayed，检查边界非零且已启用
  if (params.displayed !== undefined) {
    const { bounds } = node;
    const hasSize = bounds.width > 0 && bounds.height > 0;
    if (params.displayed !== (hasSize && node.enabled)) return false;
  }

  // String / string[] fields — each can be a single string or an array (OR).
  // 字符串字段，支持单字符串或字符串数组（数组内 OR）
  if (!matchField(node.text, toArray(params.text), (a, b) => a === b)) return false;
  if (!matchField(node.text, toArray(params.text_contains), (a, b) => a.toLowerCase().includes(b.toLowerCase()))) return false;
  if (params.text_regex !== undefined) {
    try {
      if (!new RegExp(params.text_regex).test(node.text)) return false;
    } catch {
      return false; // invalid regex = no match / 无效正则 = 不匹配
    }
  }
  if (!matchField(node.content_desc, toArray(params.content_desc), (a, b) => a === b)) return false;
  if (!matchField(node.class_name, toArray(params.class_name), (a, b) => a === b || a.endsWith(b))) return false;
  if (!matchField(node.resource_id, toArray(params.resource_id), (a, b) => a === b || a.endsWith(b))) return false;
  if (!matchField(node.package_name, toArray(params.package_name), (a, b) => a === b)) return false;

  // Boolean fields / 布尔字段
  if (params.clickable !== undefined && node.clickable !== params.clickable) return false;
  if (params.enabled !== undefined && node.enabled !== params.enabled) return false;
  if (params.focused !== undefined && node.focused !== params.focused) return false;
  if (params.checkable !== undefined && node.checkable !== params.checkable) return false;
  if (params.checked !== undefined && node.checked !== params.checked) return false;
  if (params.selected !== undefined && node.selected !== params.selected) return false;
  if (params.scrollable !== undefined && node.scrollable !== params.scrollable) return false;

  // has_* boolean fields — check for non-empty string / has_* 布尔字段——检查字符串非空
  if (params.has_text !== undefined && (node.text === "") !== params.has_text) return false;
  if (params.has_content_desc !== undefined && (node.content_desc === "") !== params.has_content_desc) return false;
  if (params.has_resource_id !== undefined && (node.resource_id === "") !== params.has_resource_id) return false;

  // Cross-field $or — at least one sub-query must match
  // 跨字段 $or —— 至少一个子查询匹配
  if (params.$or !== undefined && params.$or.length > 0) {
    if (!params.$or.some(sub => matches(node, sub))) return false;
  }

  return true;
}

/**
 * Match a node's field value against a list of candidate values using a comparator.
 * Returns true if the field matches ANY candidate (OR within array).
 * Empty candidates array = no constraint = always true.
 * / 用比较器将节点字段值与候选列表匹配。任一候选匹配则返回 true。
 */
function matchField(
  fieldValue: string,
  candidates: string[],
  compare: (a: string, b: string) => boolean,
): boolean {
  if (candidates.length === 0) return true;
  return candidates.some(candidate => compare(fieldValue, candidate));
}
