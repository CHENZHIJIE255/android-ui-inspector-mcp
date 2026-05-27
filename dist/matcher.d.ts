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
export declare function findViews(nodes: ViewNode[], params: FindParams, path?: string): ViewNode[];
