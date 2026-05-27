import { describe, it, expect } from "vitest";
import { findViews } from "./matcher.js";
import type { ViewNode } from "./types.js";

function node(overrides: Partial<ViewNode> & { children?: ViewNode[] }): ViewNode {
  return {
    index: 0,
    text: "",
    resource_id: "",
    class_name: "",
    package_name: "",
    content_desc: "",
    checkable: false,
    checked: false,
    clickable: false,
    enabled: true,
    focusable: false,
    focused: false,
    scrollable: false,
    long_clickable: false,
    password: false,
    selected: false,
    bounds: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 },
    children: [],
    ...overrides,
  };
}

describe("findViews — text matching", () => {
  const tree = [
    node({ text: "Submit", class_name: "Button" }),
    node({ text: "Cancel", class_name: "Button" }),
    node({ text: "", class_name: "TextView" }),
    node({ text: "Submit Again", class_name: "Button" }),
  ];

  it("matches exact text", () => {
    expect(findViews(tree, { text: "Submit" })).toHaveLength(1);
  });

  it("matches text with array (OR)", () => {
    const result = findViews(tree, { text: ["Submit", "Cancel"] });
    expect(result).toHaveLength(2);
  });

  it("empty text matches empty string", () => {
    expect(findViews(tree, { text: "" })).toHaveLength(1);
  });

  it("no match for non-existent text", () => {
    expect(findViews(tree, { text: "Delete" })).toHaveLength(0);
  });
});

describe("findViews — text_contains (case-insensitive)", () => {
  const tree = [
    node({ text: "Hello World" }),
    node({ text: "hello world" }),
    node({ text: "Goodbye" }),
    node({ text: "HELLO THERE" }),
  ];

  it("matches case-insensitive substring", () => {
    const result = findViews(tree, { text_contains: "hello" });
    expect(result).toHaveLength(3);
  });

  it("matches via array (OR)", () => {
    const result = findViews(tree, { text_contains: ["good", "world"] });
    expect(result).toHaveLength(3);
  });

  it("empty substring matches all", () => {
    const result = findViews(tree, { text_contains: "" });
    expect(result).toHaveLength(4);
  });

  it("no match for absent substring", () => {
    expect(findViews(tree, { text_contains: "xyzzy" })).toHaveLength(0);
  });
});

describe("findViews — text_regex", () => {
  const tree = [
    node({ text: "user@example.com" }),
    node({ text: "admin@test.org" }),
    node({ text: "no-email" }),
    node({ text: "123-456-7890" }),
  ];

  it("matches regex pattern", () => {
    expect(findViews(tree, { text_regex: "@" })).toHaveLength(2);
  });

  it("matches digit pattern", () => {
    const result = findViews(tree, { text_regex: "^\\d{3}" });
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("123-456-7890");
  });

  it("returns empty for invalid regex (does not throw)", () => {
    const result = findViews(tree, { text_regex: "[" });
    expect(result).toHaveLength(0);
  });
});

describe("findViews — class_name", () => {
  const tree = [
    node({ class_name: "android.widget.Button" }),
    node({ class_name: "android.widget.TextView" }),
    node({ class_name: "Button" }),
    node({ class_name: "android.widget.ImageView" }),
  ];

  it("matches fully qualified class name", () => {
    expect(findViews(tree, { class_name: "android.widget.Button" })).toHaveLength(1);
  });

  it("matches short class name suffix", () => {
    const result = findViews(tree, { class_name: "Button" });
    expect(result).toHaveLength(2);
  });

  it("matches via array (OR)", () => {
    const result = findViews(tree, { class_name: ["Button", "TextView"] });
    expect(result).toHaveLength(3);
  });

  it("does not match substring that is not a suffix", () => {
    expect(findViews(tree, { class_name: "widget" })).toHaveLength(0);
  });
});

describe("findViews — resource_id", () => {
  const tree = [
    node({ resource_id: "com.example:id/btn_login" }),
    node({ resource_id: "com.example:id/btn_register" }),
    node({ resource_id: "android:id/btn_login" }),
    node({ resource_id: "" }),
  ];

  it("matches full resource ID", () => {
    expect(findViews(tree, { resource_id: "com.example:id/btn_login" })).toHaveLength(1);
  });

  it("matches suffix (short ID)", () => {
    expect(findViews(tree, { resource_id: "btn_login" })).toHaveLength(2);
  });

  it("matches via array (OR)", () => {
    const result = findViews(tree, { resource_id: ["btn_login", "btn_register"] });
    expect(result).toHaveLength(3);
  });
});

describe("findViews — content_desc", () => {
  const tree = [
    node({ content_desc: "Settings icon" }),
    node({ content_desc: "Home button" }),
    node({ content_desc: "" }),
  ];

  it("matches exact content description", () => {
    expect(findViews(tree, { content_desc: "Settings icon" })).toHaveLength(1);
  });

  it("via array (OR)", () => {
    const result = findViews(tree, { content_desc: ["Settings icon", "Home button"] });
    expect(result).toHaveLength(2);
  });

  it("no match for absent desc", () => {
    expect(findViews(tree, { content_desc: "nonexistent" })).toHaveLength(0);
  });
});

describe("findViews — package_name", () => {
  const tree = [
    node({ package_name: "com.example.app" }),
    node({ package_name: "com.android.settings" }),
    node({ package_name: "com.example.app" }),
  ];

  it("matches exact package name", () => {
    expect(findViews(tree, { package_name: "com.example.app" })).toHaveLength(2);
  });

  it("via array (OR)", () => {
    const result = findViews(tree, { package_name: ["com.example.app", "com.android.settings"] });
    expect(result).toHaveLength(3);
  });

  it("no match for absent package", () => {
    expect(findViews(tree, { package_name: "com.foo.bar" })).toHaveLength(0);
  });
});

describe("findViews — boolean fields (clickable, enabled, focused)", () => {
  const tree = [
    node({ clickable: true, enabled: true, focused: true, class_name: "Button" }),
    node({ clickable: false, enabled: true, focused: false, class_name: "TextView" }),
    node({ clickable: true, enabled: false, focused: true, class_name: "Button" }),
    node({ clickable: false, enabled: false, focused: false, class_name: "TextView" }),
  ];

  it("filters by clickable", () => {
    expect(findViews(tree, { clickable: true })).toHaveLength(2);
    expect(findViews(tree, { clickable: false })).toHaveLength(2);
  });

  it("filters by enabled", () => {
    expect(findViews(tree, { enabled: false })).toHaveLength(2);
  });

  it("filters by focused", () => {
    expect(findViews(tree, { focused: true })).toHaveLength(2);
  });

  it("combines multiple boolean fields (AND)", () => {
    expect(findViews(tree, { clickable: true, enabled: true })).toHaveLength(1);
    expect(findViews(tree, { clickable: true, enabled: true, focused: true })).toHaveLength(1);
  });
});

describe("findViews — boolean fields (scrollable, selected, checkable, checked)", () => {
  const tree = [
    node({ scrollable: true, selected: true, checkable: true, checked: true }),
    node({ scrollable: false, selected: false, checkable: false, checked: false }),
  ];

  it("filters by scrollable", () => {
    expect(findViews(tree, { scrollable: true })).toHaveLength(1);
    expect(findViews(tree, { scrollable: false })).toHaveLength(1);
  });

  it("filters by selected", () => {
    expect(findViews(tree, { selected: true })).toHaveLength(1);
  });

  it("filters by checkable", () => {
    expect(findViews(tree, { checkable: true })).toHaveLength(1);
  });

  it("filters by checked", () => {
    expect(findViews(tree, { checked: true })).toHaveLength(1);
  });
});

describe("findViews — has_* fields", () => {
  const tree = [
    node({ text: "hello", content_desc: "", resource_id: "" }),
    node({ text: "", content_desc: "icon", resource_id: "" }),
    node({ text: "", content_desc: "", resource_id: "com.example:id/foo" }),
    node({ text: "", content_desc: "", resource_id: "" }),
  ];

  it("filters by has_text", () => {
    expect(findViews(tree, { has_text: true })).toHaveLength(1);
    expect(findViews(tree, { has_text: false })).toHaveLength(3);
  });

  it("filters by has_content_desc", () => {
    expect(findViews(tree, { has_content_desc: true })).toHaveLength(1);
    expect(findViews(tree, { has_content_desc: false })).toHaveLength(3);
  });

  it("filters by has_resource_id", () => {
    expect(findViews(tree, { has_resource_id: true })).toHaveLength(1);
    expect(findViews(tree, { has_resource_id: false })).toHaveLength(3);
  });

  it("combines multiple has_* fields (AND)", () => {
    expect(findViews(tree, { has_text: false, has_content_desc: false })).toHaveLength(2);
  });
});

describe("findViews — displayed (computed)", () => {
  const tree = [
    node({ bounds: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }, enabled: true }),
    node({ bounds: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, enabled: true }),
    node({ bounds: { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }, enabled: false }),
    node({ bounds: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, enabled: false }),
  ];

  it("finds displayed views (non-zero bounds + enabled)", () => {
    expect(findViews(tree, { displayed: true })).toHaveLength(1);
  });

  it("finds non-displayed views (zero bounds or disabled)", () => {
    expect(findViews(tree, { displayed: false })).toHaveLength(3);
  });
});

describe("findViews — $or (cross-field OR)", () => {
  const tree = [
    node({ text: "error", scrollable: false }),
    node({ text: "ok", scrollable: true }),
    node({ text: "info", scrollable: false }),
  ];

  it("matches nodes satisfying any sub-query", () => {
    const result = findViews(tree, {
      $or: [
        { scrollable: true },
        { text: "error" },
      ],
    });
    expect(result).toHaveLength(2);
    expect(result.map(n => n.text).sort()).toEqual(["error", "ok"]);
  });

  it("$or ANDed with top-level fields", () => {
    const tree2 = [
      node({ text: "error", package_name: "com.test" }),
      node({ text: "ok", package_name: "com.test" }),
      node({ text: "error", package_name: "com.other" }),
    ];
    const result = findViews(tree2, {
      package_name: "com.test",
      $or: [{ text: "error" }, { text: "ok" }],
    });
    expect(result).toHaveLength(2);
  });

  it("handles $or with a single sub-query", () => {
    expect(findViews(tree, { $or: [{ text: "error" }] })).toHaveLength(1);
  });

  it("returns no results when no $or sub-query matches", () => {
    const result = findViews(tree, {
      $or: [
        { text: "nonexistent" },
        { scrollable: false, text: "nope" },
      ],
    });
    expect(result).toHaveLength(0);
  });

  it("handles nested $or inside $or", () => {
    const result = findViews(tree, {
      $or: [
        { $or: [{ text: "error" }, { text: "info" }] },
      ],
    });
    expect(result).toHaveLength(2);
  });
});

describe("findViews — nested children", () => {
  const tree = [
    node({
      text: "parent",
      children: [
        node({ text: "child", clickable: true }),
        node({ text: "sibling" }),
        node({
          text: "subparent",
          children: [
            node({ text: "grandchild", clickable: true }),
          ],
        }),
      ],
    }),
  ];

  it("finds nodes at any depth", () => {
    const result = findViews(tree, { clickable: true });
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("child");
    expect(result[1].text).toBe("grandchild");
  });

  it("finds both parent and children with no filter", () => {
    expect(findViews(tree, {})).toHaveLength(5);
  });

  it("finds only matching nested nodes", () => {
    expect(findViews(tree, { text: "grandchild" })).toHaveLength(1);
  });
});

describe("findViews — no params / empty tree", () => {
  it("returns all nodes when called with empty params", () => {
    const tree = [
      node({ text: "A" }),
      node({ text: "B" }),
      node({ text: "C" }),
    ];
    expect(findViews(tree, {})).toHaveLength(3);
  });

  it("returns all nodes in a larger tree", () => {
    const tree = [
      node({ text: "A", children: [node({ text: "A1" }), node({ text: "A2" })] }),
      node({ text: "B" }),
    ];
    expect(findViews(tree, {})).toHaveLength(4);
  });

  it("empty tree returns empty", () => {
    expect(findViews([], {})).toHaveLength(0);
  });
});
