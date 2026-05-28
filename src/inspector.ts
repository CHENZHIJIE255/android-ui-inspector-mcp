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

export interface SnapshotResult {
  root: SnapshotNode;
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

  /** Check if a class (by refTypeId) is a subclass of android.app.Activity */
  private async isActivitySubclass(typeId: bigint): Promise<boolean> {
    let current: bigint | null = typeId;
    while (current !== null) {
      const sig = await this.conn.referenceTypeSignature(current);
      if (sig === "Landroid/app/Activity;") return true;
      if (sig === "Ljava/lang/Object;") break;
      current = await this.conn.classTypeSuperclass(current);
    }
    return false;
  }

  /** Read ActivityClientRecord fields as a SnapshotNode (ART fallback).
   *  On ART, getValues on Activity subclass instances hangs, so we read
   *  the Activity's state through the ActivityClientRecord instead. */
  private async acrSnapshot(jniSig: string): Promise<SnapshotNode> {
    // Walk chain to find ActivityClientRecord
    const atObjId = await this.conn.artFindActivityThreadInstance();
    if (atObjId === null) throw new Error("Cannot find ActivityThread on ART");

    const atClasses = await this.conn.classesBySignature("Landroid/app/ActivityThread;");
    const mActivitiesField = (await this.conn.referenceTypeFields(atClasses[0].typeId))
      .find(f => f.name === "mActivities");
    if (!mActivitiesField) throw new Error("No mActivities field on ActivityThread");

    const [mActVal] = await this.conn.getValues(atObjId, [mActivitiesField.fieldId]);
    if (mActVal.tag !== "object" || mActVal.objectId === null)
      throw new Error("mActivities is null");

    const amRefType = await this.conn.objectReferenceType(mActVal.objectId);
    const amAllFields = await this.conn.allFields(amRefType.typeId);
    const mArrayField = amAllFields.find(f => f.name === "mArray");
    const mSizeField = amAllFields.find(f => f.name === "mSize");
    if (!mArrayField || !mSizeField) throw new Error("ArrayMap has no mArray/mSize");

    const [arrVal, sizeVal] = await this.conn.getValues(mActVal.objectId,
      [mArrayField.fieldId, mSizeField.fieldId]);
    if (arrVal.tag !== "array" || arrVal.objectId === null || sizeVal.tag !== "int")
      throw new Error("Cannot read ArrayMap contents");

    // Read array elements to find ActivityClientRecord
    const arrLen = await this.conn.arrayLength(arrVal.objectId);
    const arrData = await this.conn.arrayValues(arrVal.objectId, 0, Math.min(arrLen, 50));
    let acrObjId: bigint | null = null;
    let actObjId: bigint | null = null;
    for (const elem of arrData) {
      if (elem.tag !== "object" || elem.objectId === null) continue;
      try {
        const rt = await this.conn.objectReferenceType(elem.objectId);
        const rsig = await this.conn.referenceTypeSignature(rt.typeId);
        if (rsig.includes("ActivityClientRecord") || rsig.includes("ActivityRecord")) {
          acrObjId = elem.objectId;
          // Read the 'activity' field to get the target Activity instance
          const recFields = await this.conn.allFields(rt.typeId);
          const actField = recFields.find(f => f.name === "activity");
          if (actField) {
            const [actVal] = await this.conn.getValues(acrObjId, [actField.fieldId]);
            if (actVal.tag === "object" && actVal.objectId !== null) {
              const actRt = await this.conn.objectReferenceType(actVal.objectId);
              const actSig = await this.conn.referenceTypeSignature(actRt.typeId);
              if (actSig === jniSig) actObjId = actVal.objectId;
            }
          }
          break;
        }
      } catch { /* skip non-ACR elements */ }
    }

    if (acrObjId === null) throw new Error("No ActivityClientRecord found");

    // Read ACR fields (these work on ART — confirmed by testing)
    const acrType = await this.conn.objectReferenceType(acrObjId);
    const acrFields = await this.conn.allFields(acrType.typeId);
    const readable = acrFields.filter(f => !f.name.startsWith("$") && f.name !== "serialVersionUID");

    const fieldMap: Record<string, SnapshotNode> = {};
    const BATCH = 30;
    for (let bs = 0; bs < readable.length; bs += BATCH) {
      const batch = readable.slice(bs, bs + BATCH);
      const vals = await this.conn.getValues(acrObjId, batch.map(f => f.fieldId));
      for (let i = 0; i < batch.length; i++) {
        const v = vals[i];
        fieldMap[batch[i].name] = { className: "unknown", objectId: "0", value: formatJdwpValue(v) };
        // Quick type resolution for object refs (avoid recursion to prevent hangs)
        if (isObjectRef(v) && v.objectId !== null) {
          try {
            const vt = await this.conn.objectReferenceType(v.objectId);
            const vs = await this.conn.referenceTypeSignature(vt.typeId);
            fieldMap[batch[i].name] = {
              className: jniToClassName(vs),
              objectId: v.objectId.toString(),
            };
          } catch { /* keep simple format */ }
        }
      }
    }

    // Add defer-to-ACR note for the Activity reference
    if (actObjId !== null) {
      fieldMap["_activity_object"] = {
        className: "com.example.test.MainActivity (ART: getValues hangs, see ACR fields)",
        objectId: actObjId.toString(),
        value: "(fields not readable on ART, use ACR fields above)",
      };
    }

    return {
      className: "android.app.ActivityThread$ActivityClientRecord (ART fallback)",
      objectId: acrObjId.toString(),
      fields: fieldMap,
    };
  }

  async snapshot(className: string, path: string): Promise<SnapshotResult> {
    const start = Date.now();
    const jniSig = "L" + className.replace(/\./g, "/") + ";";

    const classes = await this.conn.classesBySignature(jniSig);
    if (classes.length === 0) throw new Error(`class ${className} not found`);

    let instances: bigint[] = [];
    try {
      instances = await this.conn.instances(classes[0].typeId, 1);
    } catch {}
    let artFallbackUsed = false;

    // Suspend VM early for ART fallback to prevent GC invalidating object IDs
    if (instances.length === 0) {
      await this.conn.suspendVm();
      artFallbackUsed = true;
      try {
        const activityMap = await this.conn.artFindActivityInstances();
        const bySig = activityMap.get(jniSig);
        if (bySig && bySig.length > 0) {
          instances = bySig;
        }
      } catch {
        // fallback failed, will throw below
      }
    }

    if (instances.length === 0) {
      if (artFallbackUsed) { try { this.conn.resumeVm(); } catch {} }
      throw new Error(`no instances of ${className} found. Try an Activity class name.`);
    }

    if (!artFallbackUsed) {
      await this.conn.suspendVm();
    }

    let root: SnapshotNode;
    try {
      const segs = parsePath(path);
      if (segs.length === 0) {
        // Check if this is an Activity subclass — if so, use ACR fallback
        // because getValues on Activity objects hangs on ART
        if (artFallbackUsed) {
          const isActivity = await this.isActivitySubclass(classes[0].typeId);
          if (isActivity) {
            root = await this.acrSnapshot(jniSig);
          } else {
            root = await this.objectToNode(instances[0]);
          }
        } else {
          root = await this.objectToNode(instances[0]);
        }
      } else {
        const val = await this.resolve(instances[0], segs, 0);
        root = await this.valueToNode(val);
      }
    } finally {
      try { this.conn.resumeVm(); } catch { }
    }

    return { root, elapsed: Date.now() - start };
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
    const typeInfo = await this.conn.objectReferenceType(objId);
    const fields = await this.cachedFields(typeInfo.typeId);
    const f = fields.find(fi => fi.name === name);
    if (!f) return { tag: "void" };
    const vals = await this.conn.getValues(objId, [f.fieldId]);
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

    const fields = await this.cachedFields(typeInfo.typeId);
    // Read field values in batches to avoid ART choking on large requests
    const BATCH = 30;
    const fieldMap: Record<string, SnapshotNode> = {};
    for (let batchStart = 0; batchStart < fields.length; batchStart += BATCH) {
      const batch = fields.slice(batchStart, batchStart + BATCH);
      const ids = batch.map(f => f.fieldId);
      const vals = await this.conn.getValues(objId, ids);
      for (let i = 0; i < batch.length; i++) {
        const fn = batch[i].name;
        if (fn.startsWith("$") || fn === "serialVersionUID") continue;
        if (i < vals.length) {
          fieldMap[fn] = await this.valueToNode(vals[i]);
        }
      }
    }

    this.depth--;
    return { className, objectId: key, fields: fieldMap };
  }

  private async cachedFields(typeId: bigint): Promise<FieldInfo[]> {
    const key = typeId.toString();
    if (!this.fieldCache.has(key)) {
      this.fieldCache.set(key, await this.conn.allFields(typeId));
    }
    return this.fieldCache.get(key)!;
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
