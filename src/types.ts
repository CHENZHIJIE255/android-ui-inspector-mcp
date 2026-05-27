/**
 * Bounding box of an Android View node. / Android View 节点的边界框。
 */
export interface Bounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * A single node in the Android ViewTree hierarchy. / Android ViewTree 层次结构中的单个节点。
 */
export interface ViewNode {
  index: number;
  text: string;
  resource_id: string;
  class_name: string;
  package_name: string;
  content_desc: string;
  checkable: boolean;
  checked: boolean;
  clickable: boolean;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  scrollable: boolean;
  long_clickable: boolean;
  password: boolean;
  selected: boolean;
  bounds: Bounds;
  children: ViewNode[];
  /** Optional JDWP-enriched detail (added by JDWP path). / JDWP 附加信息（通过 JDWP 路径获取）。 */
  jdwp_detail?: Record<string, unknown>;
}

/**
 * Parameters for finding views. All fields are optional;
 * when multiple are specified they are ANDed together.
 * / 查找视图的参数。所有字段可选；多字段同时指定时取 AND。
 */
export interface FindParams {
  /** Exact text match. Single string or array (matched with OR). / 精确文本匹配。单个字符串或数组（数组内 OR）。 */
  text?: string | string[];
  /** Case-insensitive substring match. Single string or array (OR). / 不区分大小写的子串匹配。单个字符串或数组（OR）。 */
  text_contains?: string | string[];
  /** Regular expression match on text. / 正则表达式匹配文本。 */
  text_regex?: string;
  /** Exact content description match. Single string or array (OR). / 精确 content-desc 匹配。单个字符串或数组（OR）。 */
  content_desc?: string | string[];
  /** Class name match. Single string or array (OR). Accepts short or full qualified name. / 类名匹配，支持短名或全限定名。 */
  class_name?: string | string[];
  /** Resource ID match. Single string or array (OR). Accepts full ID or short suffix. / 资源 ID 匹配，支持完整 ID 或短后缀。 */
  resource_id?: string | string[];
  /** Package name match. Single string or array (OR). / 包名匹配。单个字符串或数组（OR）。 */
  package_name?: string | string[];
  /** Clickable state / 可点击状态 */
  clickable?: boolean;
  /** Enabled state / 启用状态 */
  enabled?: boolean;
  /** Focused state / 焦点状态 */
  focused?: boolean;
  /** Checkable state / 可选中状态 */
  checkable?: boolean;
  /** Checked state / 选中状态 */
  checked?: boolean;
  /** Selected state / 选定状态 */
  selected?: boolean;
  /** Scrollable state / 可滚动状态 */
  scrollable?: boolean;
  /** Whether the view is displayed on screen (non-zero bounds + enabled). / 视图是否显示在屏幕上（非零边界且已启用）。 */
  displayed?: boolean;
  /** Filter by whether the view has non-empty text. / 按文本是否非空过滤。 */
  has_text?: boolean;
  /** Filter by whether the view has non-empty content description. / 按 content-desc 是否非空过滤。 */
  has_content_desc?: boolean;
  /** Filter by whether the view has non-empty resource ID. / 按资源 ID 是否非空过滤。 */
  has_resource_id?: boolean;
  /**
   * Cross-field OR. Accepts an array of sub-queries; if any sub-query matches,
   * this condition is satisfied. Sub-queries support all the same fields (including $or).
   * When combined with top-level fields, $or is ANDed with them.
   * Example: { text: "hello", $or: [{ clickable: true }, { class_name: "Button" }] }
   * / 跨字段 OR。接受子查询数组，任一匹配则条件成立。与顶层字段之间为 AND 关系。
   */
  $or?: FindParams[];
  /** Target a specific device serial. Omit to auto-select. / 指定设备序列号，省略则自动选择。 */
  device_serial?: string;
}

/**
 * Result type for find_views and dump_view_tree. / find_views 和 dump_view_tree 的返回类型。
 */
export interface ViewTreeResult {
  hierarchy_rotation?: number;
  nodes: ViewNode[];
  total_count: number;
  elapsed_ms: number;
  error?: string;
}

/**
 * JDWP process info (from `adb jdwp` + ps). / JDWP 进程信息。
 */
export interface JdwpProcess {
  pid: number;
  package_name?: string;
}
