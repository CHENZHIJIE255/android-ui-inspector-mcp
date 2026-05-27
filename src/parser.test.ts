import { describe, it, expect } from "vitest";
import { parseViewTreeXml, flattenTree, parseBounds } from "./parser.js";

const BASIC_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Settings" resource-id="com.android.launcher:id/settings_button" class="android.widget.TextView" package="com.android.launcher" content-desc="Settings icon" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,2200][1080,2400]"/>
</hierarchy>`;

const NESTED_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.systemui" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="false" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2400]">
    <node index="0" text="Home" resource-id="" class="android.widget.TextView" package="com.android.systemui" content-desc="Home" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[100,200][300,400]"/>
  </node>
</hierarchy>`;

const MULTI_ROOT_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="A" class="android.widget.Button" package="com.test" bounds="[0,0][100,100]"/>
  <node index="1" text="B" class="android.widget.Button" package="com.test" bounds="[0,100][100,200]"/>
</hierarchy>`;

const ALL_ATTRIBUTES_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="1" text="Password input" resource-id="com.example:id/pwd" class="android.widget.EditText" package="com.example" content-desc="Enter password" checkable="true" checked="true" clickable="false" enabled="false" focusable="true" focused="true" scrollable="true" long-clickable="true" password="true" selected="true" bounds="[50,60][350,160]"/>
</hierarchy>`;

const DEEP_NESTED_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" class="android.widget.FrameLayout" bounds="[0,0][1080,2400]">
    <node index="0" class="android.widget.LinearLayout" bounds="[0,0][1080,2400]">
      <node index="0" class="android.widget.RelativeLayout" bounds="[0,0][1080,2400]">
        <node index="0" text="deep" class="android.widget.TextView" bounds="[100,100][200,200]"/>
      </node>
    </node>
  </node>
</hierarchy>`;

const NO_CHILDREN_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="lonely" class="android.widget.TextView" bounds="[0,0][100,50]"/>
</hierarchy>`;

const EMPTY_HIERARCHY_XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
</hierarchy>`;

describe("parseBounds", () => {
  it("parses standard bounds string", () => {
    const b = parseBounds("[0,0][1080,2400]");
    expect(b).toEqual({ left: 0, top: 0, right: 1080, bottom: 2400, width: 1080, height: 2400 });
  });

  it("parses small bounds", () => {
    const b = parseBounds("[100,200][300,400]");
    expect(b).toEqual({ left: 100, top: 200, right: 300, bottom: 400, width: 200, height: 200 });
  });

  it("parses zero-area bounds", () => {
    const b = parseBounds("[0,0][0,0]");
    expect(b).toEqual({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  });

  it("returns zeros for empty string", () => {
    const b = parseBounds("");
    expect(b).toEqual({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  });

  it("returns zeros for malformed string", () => {
    const b = parseBounds("not-a-bounds");
    expect(b).toEqual({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  });

  it("returns zeros for partially malformed string", () => {
    const b = parseBounds("[0,0]abc[100,100]");
    expect(b).toEqual({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  });
});

describe("parseViewTreeXml", () => {
  it("parses a basic leaf node", () => {
    const roots = parseViewTreeXml(BASIC_XML);
    expect(roots).toHaveLength(1);
    expect(roots[0].text).toBe("Settings");
    expect(roots[0].resource_id).toBe("com.android.launcher:id/settings_button");
    expect(roots[0].class_name).toBe("android.widget.TextView");
    expect(roots[0].package_name).toBe("com.android.launcher");
    expect(roots[0].content_desc).toBe("Settings icon");
    expect(roots[0].clickable).toBe(true);
    expect(roots[0].enabled).toBe(true);
    expect(roots[0].checkable).toBe(false);
    expect(roots[0].children).toHaveLength(0);
  });

  it("parses nested node hierarchy", () => {
    const roots = parseViewTreeXml(NESTED_XML);
    expect(roots).toHaveLength(1);
    expect(roots[0].class_name).toBe("android.widget.FrameLayout");
    expect(roots[0].children).toHaveLength(1);
    expect(roots[0].children[0].text).toBe("Home");
    expect(roots[0].children[0].clickable).toBe(true);
  });

  it("handles multiple root nodes", () => {
    const roots = parseViewTreeXml(MULTI_ROOT_XML);
    expect(roots).toHaveLength(2);
    expect(roots[0].text).toBe("A");
    expect(roots[1].text).toBe("B");
  });

  it("parses all boolean and special attributes", () => {
    const roots = parseViewTreeXml(ALL_ATTRIBUTES_XML);
    expect(roots).toHaveLength(1);
    const n = roots[0];
    expect(n.index).toBe(1);
    expect(n.text).toBe("Password input");
    expect(n.resource_id).toBe("com.example:id/pwd");
    expect(n.class_name).toBe("android.widget.EditText");
    expect(n.package_name).toBe("com.example");
    expect(n.content_desc).toBe("Enter password");
    expect(n.checkable).toBe(true);
    expect(n.checked).toBe(true);
    expect(n.clickable).toBe(false);
    expect(n.enabled).toBe(false);
    expect(n.focusable).toBe(true);
    expect(n.focused).toBe(true);
    expect(n.scrollable).toBe(true);
    expect(n.long_clickable).toBe(true);
    expect(n.password).toBe(true);
    expect(n.selected).toBe(true);
    expect(n.bounds).toEqual({ left: 50, top: 60, right: 350, bottom: 160, width: 300, height: 100 });
  });

  it("handles deep nesting with multiple levels", () => {
    const roots = parseViewTreeXml(DEEP_NESTED_XML);
    expect(roots).toHaveLength(1);
    const lv1 = roots[0].children[0];
    expect(lv1.class_name).toBe("android.widget.LinearLayout");
    const lv2 = lv1.children[0];
    expect(lv2.class_name).toBe("android.widget.RelativeLayout");
    const lv3 = lv2.children[0];
    expect(lv3.text).toBe("deep");
    expect(lv3.class_name).toBe("android.widget.TextView");
  });

  it("handles node with no children", () => {
    const roots = parseViewTreeXml(NO_CHILDREN_XML);
    expect(roots).toHaveLength(1);
    expect(roots[0].text).toBe("lonely");
    expect(roots[0].children).toHaveLength(0);
  });

  it("returns empty array for empty XML", () => {
    const roots = parseViewTreeXml("");
    expect(roots).toEqual([]);
  });

  it("returns empty array for XML without hierarchy", () => {
    const roots = parseViewTreeXml("<?xml version='1.0'?><foo/>");
    expect(roots).toEqual([]);
  });

  it("returns empty array for hierarchy with no node children", () => {
    const roots = parseViewTreeXml(EMPTY_HIERARCHY_XML);
    expect(roots).toEqual([]);
  });

  it("preserves numeric index values", () => {
    const roots = parseViewTreeXml(MULTI_ROOT_XML);
    expect(roots[0].index).toBe(0);
    expect(roots[1].index).toBe(1);
  });
});

describe("flattenTree", () => {
  it("flattens a single node", () => {
    const roots = parseViewTreeXml(BASIC_XML);
    const flat = flattenTree(roots);
    expect(flat).toHaveLength(1);
  });

  it("flattens nested nodes in DFS pre-order", () => {
    const roots = parseViewTreeXml(NESTED_XML);
    const flat = flattenTree(roots);
    expect(flat).toHaveLength(2);
    expect(flat[0].class_name).toBe("android.widget.FrameLayout");
    expect(flat[1].class_name).toBe("android.widget.TextView");
  });

  it("flattens deep nesting correctly", () => {
    const roots = parseViewTreeXml(DEEP_NESTED_XML);
    const flat = flattenTree(roots);
    expect(flat).toHaveLength(4);
    expect(flat[0].class_name).toBe("android.widget.FrameLayout");
    expect(flat[1].class_name).toBe("android.widget.LinearLayout");
    expect(flat[2].class_name).toBe("android.widget.RelativeLayout");
    expect(flat[3].class_name).toBe("android.widget.TextView");
  });

  it("returns empty for empty input", () => {
    expect(flattenTree([])).toEqual([]);
  });
});
