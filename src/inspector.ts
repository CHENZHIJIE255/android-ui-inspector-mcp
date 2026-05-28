/**
 * In-memory field inspector via JDWP path expressions.
 *
 * Walks an object graph on a suspended VM by resolving dot-notation paths
 * like "mViewModel.mDataList[0].title". Supports arrays, ArrayLists,
 * cycle detection, and depth limits.
 *
 * Pattern: connect -> findClass -> getInstances -> suspend -> read -> resume
 */
import { JdwpConnection, JdwpValue, FieldInfo } from "./jdwp.js";

const DEFAULT_MAX_DEPTH = 8;

interface Seg {
  type: "dot" | "index" | "wildcard";
  name: string;
  idx: number;
}

export function parsePath(path: string): Seg[] {
  const segs: Seg[] = [];
  let buf = "";
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === ".") {
      if (buf) segs.push({ type: "dot", name: buf, idx: 0 });
      buf = "";
    } else if (ch === "[") {
      if (buf) segs.push({ type: "dot", name: buf, idx: 0 });
      buf = "";
      i++;
      while (i < path.length && path[i] !== "]") { buf += path[i]; i++; }
      if (buf === "*") {
        segs.push({ type: "wildcard", name: "", idx: 0 });
      } else {
        segs.push({ type: "index", name: "", idx: parseInt(buf, 10) });
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf) segs.push({ type: "dot", name: buf, idx: 0 });
  return segs;
}

export interface SnapshotNode {
  className: string;
  objectId: string;
  value?: string;
  fields?: Record<string, SnapshotNode>;
  elements?: SnapshotNode[];
  circular?: boolean;
  depthLimit?: boolean;
  null?: boolean;
}

export interface ThreadInfo {
  id: string;
  name: string;
  frames: string[];
}

export interface DiagnosticInfo {
  threads: ThreadInfo[];
  mainThreadFrames: string[];
  objectHash: string;
}

export interface SnapshotResult {
  root: SnapshotNode;
  diagnostics?: DiagnosticInfo;
  elapsed: number;
}

export class ObjectInspector {
  private conn: JdwpConnection;
  private visited = new Set<string>();
  private fieldCache = new Map<string, FieldInfo[]>();
  private maxDepth: number;
  private depth = 0;

  constructor(conn: JdwpConnection, maxDepth = DEFAULT_MAX_DEPTH) {
    this.conn = conn;
    this.maxDepth = maxDepth;
  }

  async snapshot(className: string, path: string): Promise<SnapshotResult> {
    const start = Date.now();
    const jniSig = "L" + className.replace(/\./g, "/") + ";";

    // Find the target class and instance
    const classes = await this.conn.classesBySignature(jniSig);
    if (classes.length === 0) throw new Error(`class ${className} not found`);

    let instances: bigint[] = [];
    // Suspend VM minimally — only when we know we need object-level reads
    let suspended = false;
    if (path) {
      // Path-based: suspend, resolve, resume
      try { instances = await this.conn.instances(classes[0].typeId, 1); } catch {}
      if (instances.length === 0) {
        await this.conn.suspendVm(); suspended = true;
        const activityMap = await this.conn.artFindActivityInstances();
        const bySig = activityMap.get(jniSig);
        if (bySig && bySig.length > 0) instances = bySig;
      }
      if (instances.length === 0) throw new Error(`no instances of ${className} found`);
      if (!suspended) { await this.conn.suspendVm(); suspended = true; }
      try {
        const segs = parsePath(path);
        const val = await this.resolve(instances[0], segs, 0);
        const root = await this.valueToNode(val);
        return { root, elapsed: Date.now() - start };
      } finally {
        try { this.conn.resumeVm(); } catch {}
      }
    }

    // No path: fast snapshot of declared fields + diagnostics
    // Step 1: Find instance (no VM suspension needed for type queries)
    try { instances = await this.conn.instances(classes[0].typeId, 1); } catch {}
    if (instances.length === 0) {
      // ART fallback — suspend once, do all reads, resume
      await this.conn.suspendVm(); suspended = true;
      try {
        const activityMap = await this.conn.artFindActivityInstances();
        const bySig = activityMap.get(jniSig);
        if (bySig && bySig.length > 0) instances = bySig;
      } catch {}
    }
    if (instances.length === 0) throw new Error(`no instances of ${className} found`);

    if (!suspended) await this.conn.suspendVm();

    try {
      const objId = instances[0];
      const typeInfo = await this.conn.objectReferenceType(objId);
      const sig = await this.conn.referenceTypeSignature(typeInfo.typeId);
      const cn = jniToClassName(sig);

      // Read ONLY declared fields (not allFields which triggers ANR from 437 fields)
      const allDeclared = await this.conn.referenceTypeFields(typeInfo.typeId);
      const readableFields = allDeclared.filter(
        f => !f.name.startsWith("$") && f.name !== "serialVersionUID"
      );

      const fieldMap: Record<string, SnapshotNode> = {};
      const BATCH = 30;
      for (let bs = 0; bs < readableFields.length; bs += BATCH) {
        const batch = readableFields.slice(bs, bs + BATCH);
        const vals = await this.conn.getValues(objId, batch.map(f => f.fieldId));
        for (let i = 0; i < batch.length; i++) {
          const fn = batch[i].name;
          if (i < vals.length) {
            fieldMap[fn] = await this.valueToNode(vals[i]);
          }
        }
      }

      const root: SnapshotNode = { className: cn, objectId: objId.toString(), fields: fieldMap };

      // Collect diagnostics (threads, stacks)
      const diagnostics = await this.collectDiagnostics(objId);

      return { root, diagnostics, elapsed: Date.now() - start };
    } finally {
      try { this.conn.resumeVm(); } catch {}
    }
  }

  /** Collect diagnostic context from the suspended VM:
   *  thread list, main thread stack trace, and object identity hash. */
  private async collectDiagnostics(objId: bigint): Promise<DiagnosticInfo> {
    const threads = await this.conn.allThreads();
    const threadList: ThreadInfo[] = [];
    let mainThreadFrames: string[] = [];

    for (let i = 0; i < threads.length; i++) {
      const tid = threads[i];
      let name = "";
      try { name = await this.conn.threadName(tid); } catch { name = `thread_${tid}`; }

      // Get first 5 stack frames for each thread
      let frames: string[] = [];
      try {
        const rawFrames = await this.conn.threadFrames(tid, 0, 5);
        frames = await Promise.all(rawFrames.map(async (f) => {
          let clsName = "?";
          try {
            const sig = await this.conn.referenceTypeSignature(f.location.typeId);
            clsName = jniToClassName(sig);
          } catch {}
          return `${clsName} methodIndex=${f.location.methodIndex}`;
        }));
      } catch { frames = ["(frames unavailable)"]; }

      threadList.push({ id: tid.toString(), name, frames });

      // Track main thread separately
      if (name === "main" || name.includes("main")) {
        mainThreadFrames = frames;
      }
    }

    // Read object identity hash via JDWP — use reference type signature as proxy
    let objHash = "";
    try {
      const info = await this.conn.objectReferenceType(objId);
      objHash = `refTypeId=${info.typeId} tag=${info.refTypeTag}`;
    } catch { objHash = "(unavailable)"; }

    return { threads: threadList, mainThreadFrames, objectHash: objHash };
  }

  private async resolve(objId: bigint, segs: Seg[], i: number): Promise<JdwpValue> {
    const seg = segs[i];
    let val: JdwpValue;

    if (seg.type === "dot") {
      val = await this.readField(objId, seg.name);
    } else if (seg.type === "index") {
      val = await this.readIndex(objId, seg.idx);
    } else {
      return this.resolveWildcard(objId, segs, i);
    }

    if (i === segs.length - 1) return val;
    const nextId = extractId(val);
    if (nextId === null) return { tag: "void" };
    return this.resolve(nextId, segs, i + 1);
  }

  private async resolveWildcard(objId: bigint, segs: Seg[], i: number): Promise<JdwpValue> {
    const elems = await this.readAllElements(objId);
    const results: JdwpValue[] = [];
    for (const e of elems) {
      if (i === segs.length - 1) {
        results.push(e);
      } else {
        const id = extractId(e);
        if (id !== null) results.push(await this.resolve(id, segs, i + 1));
      }
    }
    return { tag: "array", elements: results } as any;
  }

  private async readField(objId: bigint, name: string): Promise<JdwpValue> {
    const hierarchy = await this.findFieldInHierarchy(objId, name);
    if (!hierarchy) return { tag: "void" };
    const vals = await this.conn.getValues(objId, [hierarchy.field.fieldId]);
    return vals[0];
  }

  private async readIndex(objId: bigint, idx: number): Promise<JdwpValue> {
    const typeInfo = await this.conn.objectReferenceType(objId);
    if (typeInfo.refTypeTag === 3) {
      const vals = await this.conn.arrayValues(objId, idx, 1);
      return vals.length > 0 ? vals[0] : { tag: "void" };
    }
    const fields = await this.cachedFields(typeInfo.typeId);
    const dataF = fields.find(f => f.name === "elementData");
    const sizeF = fields.find(f => f.name === "size");
    if (dataF && sizeF) {
      const [dataVal, sizeVal] = await this.conn.getValues(objId, [dataF.fieldId, sizeF.fieldId]);
      if (dataVal.tag === "array" && dataVal.objectId !== null && sizeVal.tag === "int" && idx < sizeVal.value) {
        const vals = await this.conn.arrayValues(dataVal.objectId, idx, 1);
        if (vals.length > 0) return vals[0];
      }
    }
    return { tag: "void" };
  }

  private async readAllElements(objId: bigint): Promise<JdwpValue[]> {
    const typeInfo = await this.conn.objectReferenceType(objId);
    if (typeInfo.refTypeTag === 3) {
      const len = await this.conn.arrayLength(objId);
      return this.conn.arrayValues(objId, 0, Math.min(len, 200));
    }
    const fields = await this.cachedFields(typeInfo.typeId);
    const dataF = fields.find(f => f.name === "elementData");
    const sizeF = fields.find(f => f.name === "size");
    if (dataF && sizeF) {
      const [dataVal, sizeVal] = await this.conn.getValues(objId, [dataF.fieldId, sizeF.fieldId]);
      if (dataVal.tag === "array" && dataVal.objectId !== null && sizeVal.tag === "int") {
        return this.conn.arrayValues(dataVal.objectId, 0, Math.min(sizeVal.value, 200));
      }
    }
    return [];
  }

  private async valueToNode(val: JdwpValue): Promise<SnapshotNode> {
    if (val.tag === "void") return { className: "void", objectId: "0", null: true };
    const prim = primValue(val);
    if (prim !== undefined) return { className: typeTag(val), objectId: "0", value: prim };
    if (val.tag === "string") {
      if (val.objectId === null) return { className: "null", objectId: "0", null: true };
      let str = "(string)";
      try { str = await this.conn.stringValue(val.objectId); } catch {}
      return { className: "java.lang.String", objectId: val.objectId.toString(), value: str };
    }
    if ((val.tag === "object" || val.tag === "array") && val.objectId === null) {
      return { className: "null", objectId: "0", null: true };
    }
    if ((val.tag === "object" || val.tag === "array") && val.objectId !== null) {
      return this.objectToNode(val.objectId);
    }
    return { className: "null", objectId: "0", null: true };
  }

  private async objectToNode(objId: bigint): Promise<SnapshotNode> {
    const key = objId.toString();
    if (this.visited.has(key)) {
      return { className: "(circular)", objectId: key, circular: true };
    }
    if (this.depth >= this.maxDepth) {
      return { className: "(depthLimit)", objectId: key, depthLimit: true };
    }
    this.visited.add(key);
    this.depth++;

    const typeInfo = await this.conn.objectReferenceType(objId);
    const sig = await this.conn.referenceTypeSignature(typeInfo.typeId);
    const className = jniToClassName(sig);

    if (className === "java.lang.String") {
      this.depth--;
      return { className, objectId: key, value: "(string)" };
    }

    const allFields = await this.cachedFields(typeInfo.typeId);
    const fields = allFields.filter(f => !f.name.startsWith("$") && f.name !== "serialVersionUID");
    const BATCH = 30;
    const fieldMap: Record<string, SnapshotNode> = {};
    for (let batchStart = 0; batchStart < fields.length; batchStart += BATCH) {
      const batch = fields.slice(batchStart, batchStart + BATCH);
      const ids = batch.map(f => f.fieldId);
      const vals = await this.conn.getValues(objId, ids);
      for (let i = 0; i < batch.length; i++) {
        const fn = batch[i].name;
        if (i < vals.length) {
          fieldMap[fn] = await this.valueToNode(vals[i]);
        }
      }
    }

    this.depth--;
    return { className, objectId: key, fields: fieldMap };
  }

  /** Read declared fields only. Walks the superclass chain on demand
   *  only when a named field is not found in the direct type. */
  private async cachedFields(typeId: bigint): Promise<FieldInfo[]> {
    const key = typeId.toString();
    if (!this.fieldCache.has(key)) {
      this.fieldCache.set(key, await this.conn.referenceTypeFields(typeId));
    }
    return this.fieldCache.get(key)!;
  }

  /** Find a field by name, checking the type hierarchy.
   *  Returns the declaring class's typeId and the field info, or null. */
  private async findFieldInHierarchy(objId: bigint, name: string): Promise<{ typeId: bigint; field: FieldInfo } | null> {
    const typeInfo = await this.conn.objectReferenceType(objId);
    let currentId: bigint | null = typeInfo.typeId;
    while (currentId !== null) {
      const fields = await this.conn.referenceTypeFields(currentId);
      const found = fields.find(f => f.name === name);
      if (found) return { typeId: currentId, field: found };
      const sig = await this.conn.referenceTypeSignature(currentId);
      if (sig === "Ljava/lang/Object;") break;
      currentId = await this.conn.classTypeSuperclass(currentId);
    }
    return null;
  }
}

function formatJdwpValue(v: JdwpValue): string {
  const prim = primValue(v);
  if (prim !== undefined) return prim;
  if (v.tag === "void") return "void";
  if (v.tag === "object" || v.tag === "array" || v.tag === "string") {
    return v.objectId === null ? "null" : `ref(${v.objectId})`;
  }
  return JSON.stringify(v, (k, val) => typeof val === "bigint" ? val.toString() : val);
}

function isObjectRef(v: JdwpValue): v is Extract<JdwpValue, { objectId: unknown }> {
  return v.tag === "object" || v.tag === "array" || v.tag === "string";
}

function typeTag(v: JdwpValue): string {
  switch (v.tag) {
    case "byte": case "char": case "float": case "double":
    case "int": case "long": case "short": case "boolean":
      return v.tag;
    default: return v.tag;
  }
}

function primValue(v: JdwpValue): string | undefined {
  switch (v.tag) {
    case "byte": return String(v.value);
    case "char": return String.fromCharCode(v.value);
    case "float": return String(v.value);
    case "double": return String(v.value);
    case "int": return String(v.value);
    case "long": return String(v.value);
    case "short": return String(v.value);
    case "boolean": return String(v.value);
    default: return undefined;
  }
}

function extractId(v: JdwpValue): bigint | null {
  if (v.tag === "object" || v.tag === "array" || v.tag === "string") return v.objectId;
  return null;
}

export function jniToClassName(jni: string): string {
  let s = jni;
  if (s.startsWith("L") && s.endsWith(";")) s = s.slice(1, -1);
  const dims = (s.match(/^\[+/) || [""])[0].length;
  if (dims > 0) s = s.slice(dims);
  if (s.startsWith("L") && s.endsWith(";")) s = s.slice(1, -1);
  return s.replace(/\//g, ".") + "[]".repeat(dims);
}
