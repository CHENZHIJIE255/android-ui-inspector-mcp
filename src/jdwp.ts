/**
 * Raw JDWP protocol implementation in TypeScript.
 * Speaks the JDWP wire protocol directly over TCP — no JDI, no Java.
 */
import { createConnection, Socket } from "net";

// ── JDWP ID Sizes (queried at connection time) ──
export interface IdSizes {
  fieldID: number;
  methodID: number;
  objectID: number;
  referenceTypeID: number;
  frameID: number;
}

// ── JDWP value types ──
export type JdwpValue =
  | { tag: "byte"; value: number }
  | { tag: "char"; value: number }
  | { tag: "float"; value: number }
  | { tag: "double"; value: number }
  | { tag: "int"; value: number }
  | { tag: "long"; value: bigint }
  | { tag: "short"; value: number }
  | { tag: "boolean"; value: boolean }
  | { tag: "void" }
  | { tag: "object"; objectId: bigint | null }
  | { tag: "array"; objectId: bigint | null }
  | { tag: "string"; objectId: bigint }
  | { tag: "thread"; objectId: bigint }
  | { tag: "classLoader"; objectId: bigint }
  | { tag: "classObject"; objectId: bigint };

// ── Reference type info ──
export interface RefTypeInfo {
  refTypeTag: number; // 1=class, 2=interface, 3=array
  typeId: bigint;
  signature: string;
  status: number;
}

// ── Field info ──
export interface FieldInfo {
  fieldId: bigint;
  name: string;
  signature: string;
  modBits: number;
}

// ── JDWP Packet ──
interface Packet {
  length: number;
  id: number;
  flags: number;
  errorCode?: number;
  commandSet?: number;
  command?: number;
  data: Buffer;
}

// ── Tag byte values ──
const TAG = {
  BYTE: 0x42,      // 'B'
  CHAR: 0x43,      // 'C'
  FLOAT: 0x46,     // 'F'
  DOUBLE: 0x44,    // 'D'
  INT: 0x49,       // 'I'
  LONG: 0x4a,      // 'J'
  SHORT: 0x53,     // 'S'
  BOOLEAN: 0x5a,   // 'Z'
  VOID: 0x56,      // 'V'
  OBJECT: 0x4c,    // 'L'
  ARRAY: 0x5b,     // '['
  STRING: 0x73,    // 's'
  THREAD: 0x74,    // 't'
  CLASS_LOADER: 0x67, // 'g'
  CLASS_OBJECT: 0x63, // 'c'
} as const;

// ── Packet ID counter ──
let nextPacketId = 1;

export class JdwpConnection {
  private socket: Socket | null = null;
  private idSizes: IdSizes | null = null;
  private pending = new Map<number, { resolve: (buf: Buffer) => void; reject: (err: Error) => void }>();
  private buf = Buffer.alloc(0);

  async connect(port: number, host = "127.0.0.1"): Promise<void> {
    this.socket = createConnection({ port, host });

    // Combined connect + handshake in one promise to avoid a Node.js ESM
    // timing issue where awaiting the connect event separately caused the
    // handshake write to be swallowed or the reply to be missed on ART.
    await new Promise<void>((resolve, reject) => {
      const s = this.socket!;
      const timer = setTimeout(() => reject(new Error("handshake timeout")), 5000);
      s.on("connect", () => {
        s.write("JDWP-Handshake");
        s.once("data", (data) => {
          clearTimeout(timer);
          const ok = data.toString("ascii", 0, 14) === "JDWP-Handshake";
          if (!ok) { reject(new Error("JDWP-Handshake failed")); return; }
          s.on("data", (chunk) => this.onData(chunk));
          this.queryIdSizes()
            .then(sizes => { this.idSizes = sizes; resolve(); })
            .catch(reject);
        });
        s.once("error", (err) => { clearTimeout(timer); reject(err); });
      });
      s.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  }

  disconnect(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
    // Reject all pending
    for (const [, p] of this.pending) {
      p.reject(new Error("disconnected"));
    }
    this.pending.clear();
  }

  get sizes(): IdSizes {
    if (!this.idSizes) throw new Error("not connected, call connect() first");
    return this.idSizes;
  }

  // ── High-level JDWP commands ──

  /** Suspend all threads in the VM. CommandSet=1, Command=8 */
  async suspendVm(): Promise<void> {
    await this.sendCommand(1, 8);
  }

  /** Resume all threads in the VM. CommandSet=1, Command=9 */
  async resumeVm(): Promise<void> {
    await this.sendCommand(1, 9);
  }

  /** Get all threads. CommandSet=1, Command=4 */
  async allThreads(): Promise<bigint[]> {
    const reply = await this.sendCommand(1, 4);
    let off = 0;
    const count = reply.readInt32BE(off); off += 4;
    const result: bigint[] = [];
    for (let i = 0; i < count; i++) {
      result.push(this.readId(reply, off, this.sizes.objectID)); off += this.sizes.objectID;
    }
    return result;
  }

  /** Get thread name. CommandSet=11, Command=1 */
  async threadName(threadId: bigint): Promise<string> {
    const data = Buffer.alloc(this.sizes.objectID);
    this.writeId(data, 0, threadId, this.sizes.objectID);
    const reply = await this.sendCommand(11, 1, data);
    return this.decodeString(reply, 0);
  }

  /** Get stack frames for a thread. CommandSet=11, Command=6
   *  startFrame=0, length=-1 for all frames. */
  async threadFrames(threadId: bigint, startFrame = 0, length = -1): Promise<{ frameId: bigint; location: { typeTag: number; typeId: bigint; methodIndex: number } }[]> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.objectID + 4 + 4);
    let off = 0;
    this.writeId(data, off, threadId, sizes.objectID); off += sizes.objectID;
    data.writeInt32BE(startFrame, off); off += 4;
    data.writeInt32BE(length, off); off += 4;
    const reply = await this.sendCommand(11, 6, data);
    off = 0;
    const count = reply.readInt32BE(off); off += 4;
    const result: any[] = [];
    for (let i = 0; i < count; i++) {
      const frameId = this.readId(reply, off, sizes.frameID); off += sizes.frameID;
      // Location: typeTag(byte) + typeID(referenceTypeID) + methodIndex(8 bytes for ART? 4/8?)
      const locTypeTag = reply[off]; off += 1;
      const locTypeId = this.readId(reply, off, sizes.referenceTypeID); off += sizes.referenceTypeID;
      const methodIndex = this.readId(reply, off, sizes.methodID); off += sizes.methodID;
      result.push({ frameId, location: { typeTag: locTypeTag, typeId: locTypeId, methodIndex: Number(methodIndex) } });
    }
    return result;
  }

  /** Get frame count for a thread. CommandSet=11, Command=7 */
  async threadFrameCount(threadId: bigint): Promise<number> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.objectID);
    this.writeId(data, 0, threadId, sizes.objectID);
    const reply = await this.sendCommand(11, 7, data);
    return reply.readInt32BE(0);
  }

  /** Get stack frame slot values. CommandSet=16, Command=1.
   *  Each slot: { slot: number, sigByte: number } where sigByte is a JNI signature
   *  character code (e.g., 0x4c='L' for object). */
  async getFrameValues(threadId: bigint, frameId: bigint, slots: { slot: number; sigByte: number }[]): Promise<JdwpValue[]> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.objectID + sizes.frameID + 4 + slots.length * (4 + 1));
    let off = 0;
    this.writeId(data, off, threadId, sizes.objectID); off += sizes.objectID;
    this.writeId(data, off, frameId, sizes.frameID); off += sizes.frameID;
    data.writeInt32BE(slots.length, off); off += 4;
    for (const s of slots) {
      data.writeInt32BE(s.slot, off); off += 4;
      data[off] = s.sigByte; off += 1;
    }
    const reply = await this.sendCommand(16, 1, data);
    return this.decodeValues(reply, 0, slots.length);
  }

  /** Get all classes matching the JNI-style signature. CommandSet=1, Command=2
   *
   * NOTE: On ART (Android Runtime), the reply OMITS the signature string —
   * it only returns refTypeTag + typeID + status per class, unlike the JDWP spec
   * which includes the signature. We supply the requested signature back. */
  async classesBySignature(signature: string): Promise<RefTypeInfo[]> {
    const data = this.encodeString(signature);
    const reply = await this.sendCommand(1, 2, data);
    let off = 0;
    const count = reply.readInt32BE(off); off += 4;
    const result: RefTypeInfo[] = [];
    for (let i = 0; i < count; i++) {
      const refTypeTag = reply[off]; off += 1;
      const typeId = this.readId(reply, off, this.sizes.referenceTypeID); off += this.sizes.referenceTypeID;
      // ART omits signature string in the reply, so we use the requested one
      const status = reply.readInt32BE(off); off += 4;
      result.push({ refTypeTag, typeId, signature, status });
    }
    return result;
  }

  /** Get instances of a reference type. CommandSet=2, Command=10 */
  async instances(typeId: bigint, maxInstances = 1): Promise<bigint[]> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.referenceTypeID + 4);
    this.writeId(data, 0, typeId, sizes.referenceTypeID);
    data.writeInt32BE(maxInstances, sizes.referenceTypeID);
    const reply = await this.sendCommand(2, 10, data);
    let off = 0;
    const count = reply.readInt32BE(off); off += 4;
    const result: bigint[] = [];
    for (let i = 0; i < count; i++) {
      const id = this.readId(reply, off, sizes.objectID); off += sizes.objectID;
      result.push(id);
    }
    return result;
  }

  /** Get the superclass of a class type. CommandSet=3, Command=1.
   *  Returns null if the class has no superclass (i.e. java.lang.Object).
   *  NOTE: On ART, the reply is just the referenceTypeID (no refTypeTag byte). */
  async classTypeSuperclass(typeId: bigint): Promise<bigint | null> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.referenceTypeID);
    this.writeId(data, 0, typeId, sizes.referenceTypeID);
    const reply = await this.sendCommand(3, 1, data);
    // ART: reply is just referenceTypeID (8 bytes). Standard JDWP has refTypeTag prefix.
    const off = reply.length === sizes.referenceTypeID ? 0 : 1;
    const superId = this.readId(reply, off, sizes.referenceTypeID);
    return superId === BigInt(0) ? null : superId;
  }

  /** Get ALL fields including inherited (walks superclass chain). */
  async allFields(typeId: bigint): Promise<FieldInfo[]> {
    const all: FieldInfo[] = [];
    const seen = new Set<string>();
    let current: bigint | null = typeId;
    while (current !== null) {
      const fields = await this.referenceTypeFields(current);
      for (const f of fields) {
        const key = f.fieldId.toString();
        if (!seen.has(key)) {
          seen.add(key);
          all.push(f);
        }
      }
      const sig = await this.referenceTypeSignature(current);
      if (sig === "Ljava/lang/Object;") break;
      current = await this.classTypeSuperclass(current);
    }
    return all;
  }

  /** Get fields of a reference type (directly declared only). CommandSet=2, Command=4 */
  async referenceTypeFields(typeId: bigint): Promise<FieldInfo[]> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.referenceTypeID);
    this.writeId(data, 0, typeId, sizes.referenceTypeID);
    const reply = await this.sendCommand(2, 4, data);
    let off = 0;
    const count = reply.readInt32BE(off); off += 4;
    const result: FieldInfo[] = [];
    for (let i = 0; i < count; i++) {
      const fieldId = this.readId(reply, off, sizes.fieldID); off += sizes.fieldID;
      const name = this.decodeString(reply, off);
      off += 4 + Buffer.byteLength(name, "utf-8");
      const sig = this.decodeString(reply, off);
      off += 4 + Buffer.byteLength(sig, "utf-8");
      const modBits = reply.readInt32BE(off); off += 4;
      result.push({ fieldId, name, signature: sig, modBits });
    }
    return result;
  }

  /** Get the reference type of an object. CommandSet=9, Command=1 */
  async objectReferenceType(objectId: bigint): Promise<{ refTypeTag: number; typeId: bigint }> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.objectID);
    this.writeId(data, 0, objectId, sizes.objectID);
    const reply = await this.sendCommand(9, 1, data);
    return {
      refTypeTag: reply[0],
      typeId: this.readId(reply, 1, sizes.referenceTypeID),
    };
  }

  /** Get field values of an object. CommandSet=9, Command=2
   *
   *  NOTE: On ART (Android Runtime), this command hangs indefinitely when
   *  the target object is an Activity or ComponentActivity subclass instance.
   *  System objects (ActivityThread, ArrayMap, etc.) work fine.
   *  Root cause is unknown — possibly an ART JDWP internal lock. */
  async getValues(objectId: bigint, fieldIds: bigint[]): Promise<JdwpValue[]> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.objectID + 4 + fieldIds.length * sizes.fieldID);
    let off = 0;
    this.writeId(data, off, objectId, sizes.objectID); off += sizes.objectID;
    data.writeInt32BE(fieldIds.length, off); off += 4;
    for (const fid of fieldIds) {
      this.writeId(data, off, fid, sizes.fieldID); off += sizes.fieldID;
    }
    const reply = await this.sendCommand(9, 2, data);
    // ART prefixes tagged-values with count(4); standard JDWP does not.
    // If the first byte is not a valid tag, skip the count.
    const startOff = (reply[0] <= 0x40 || reply[0] >= 0x7a) ? 4 : 0;
    return this.decodeValues(reply, startOff, fieldIds.length);
  }

  async referenceTypeStaticValues(typeId: bigint, fieldIds: bigint[]): Promise<JdwpValue[]> {
    try {
      return await this._staticValuesCmd(2, 5, typeId, fieldIds);
    } catch {
      return this._staticValuesCmd(2, 16, typeId, fieldIds);
    }
  }

  private async _staticValuesCmd(cmdSet: number, cmd: number, typeId: bigint, fieldIds: bigint[]): Promise<JdwpValue[]> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.referenceTypeID + 4 + fieldIds.length * sizes.fieldID);
    let off = 0;
    this.writeId(data, off, typeId, sizes.referenceTypeID); off += sizes.referenceTypeID;
    data.writeInt32BE(fieldIds.length, off); off += 4;
    for (const fid of fieldIds) {
      this.writeId(data, off, fid, sizes.fieldID); off += sizes.fieldID;
    }
    const reply = await this.sendCommandRaw(cmdSet, cmd, data);
    // ART cmd 16 returns count(4) before tagged-values; standard cmd 5 does not.
    // Detect by reading first 4 bytes: if they match fieldIds.length, skip them.
    if (cmd === 16 && reply.length >= 4) {
      const count = reply.readInt32BE(0);
      if (count === fieldIds.length && reply.length > 4) {
        return this.decodeValues(reply, 4, fieldIds.length);
      }
    }
    return this.decodeValues(reply, 0, fieldIds.length);
  }

  async artFindActivityThreadInstance(): Promise<bigint | null> {
    const atClasses = await this.classesBySignature("Landroid/app/ActivityThread;");
    if (atClasses.length === 0) return null;
    const fields = await this.referenceTypeFields(atClasses[0].typeId);
    const staticField = fields.find(f => f.name === "sCurrentActivityThread");
    if (!staticField) return null;
    const vals = await this._staticValuesCmd(2, 16, atClasses[0].typeId, [staticField.fieldId]);
    if (vals.length === 0 || vals[0].tag === "void") return null;
    return (vals[0] as any).objectId as bigint | null;
  }

  async artFindActivityInstances(): Promise<Map<string, bigint[]>> {
    const result = new Map<string, bigint[]>();
    const atObjId = await this.artFindActivityThreadInstance();
    if (atObjId === null) return result;

    const atClasses = await this.classesBySignature("Landroid/app/ActivityThread;");
    const atFields = await this.referenceTypeFields(atClasses[0].typeId);
    const mActivitiesField = atFields.find(f => f.name === "mActivities");
    if (!mActivitiesField) return result;

    const mActVals = await this.getValues(atObjId, [mActivitiesField.fieldId]);
    const mActVal = mActVals[0];
    if (mActVal.tag !== "object" || mActVal.objectId === null) return result;
    const amObjId = mActVal.objectId;

    const amRefType = await this.objectReferenceType(amObjId);
    const amAllFields = await this.allFields(amRefType.typeId);
    const mArray = amAllFields.find(f => f.name === "mArray");
    const mSize = amAllFields.find(f => f.name === "mSize");
    if (!mArray || !mSize) return result;

    const fieldVals = await this.getValues(amObjId, [mArray.fieldId, mSize.fieldId]);
    const arrVal = fieldVals[0];
    const sizeVal = fieldVals[1];
    if (arrVal.tag !== "array" || arrVal.objectId === null || sizeVal.tag !== "int") return result;
    const mapSize = sizeVal.value;
    if (mapSize <= 0) return result;

    const arrLen = await this.arrayLength(arrVal.objectId);
    const rawBuf = Buffer.alloc(8 + 4 + 4);
    rawBuf.writeBigUInt64BE(arrVal.objectId, 0);
    rawBuf.writeInt32BE(0, 8);
    rawBuf.writeInt32BE(Math.min(arrLen, mapSize * 2), 12);
    const rawArr = await this.sendCommandRaw(13, 2, rawBuf);

    const elemCount = rawArr.readInt32BE(1);
    let dataOff = 5;
    for (let i = 0; i < elemCount && dataOff < rawArr.length; i++) {
      const tag = rawArr[dataOff]; dataOff += 1;
      const oid = this.readId(rawArr, dataOff, this.sizes.objectID); dataOff += this.sizes.objectID;
      if (oid === BigInt(0)) continue;
      try {
        const rt = await this.objectReferenceType(oid);
        const sig = await this.referenceTypeSignature(rt.typeId);
        if (sig.includes("ActivityClientRecord") || sig.includes("ActivityRecord")) {
          const recFields = await this.allFields(rt.typeId);
          const actField = recFields.find(f => f.name === "activity");
          if (actField) {
            const actVals = await this.getValues(oid, [actField.fieldId]);
            const actVal = actVals[0];
            if (actVal.tag === "object" && actVal.objectId !== null) {
              const actRt = await this.objectReferenceType(actVal.objectId);
              const actSig = await this.referenceTypeSignature(actRt.typeId);
              const list = result.get(actSig) || [];
              list.push(actVal.objectId);
              result.set(actSig, list);
            }
          }
        }
      } catch {}
    }
    return result;
  }

  /** Get the JNI signature of a reference type. CommandSet=2, Command=1 */
  async referenceTypeSignature(typeId: bigint): Promise<string> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.referenceTypeID);
    this.writeId(data, 0, typeId, sizes.referenceTypeID);
    const reply = await this.sendCommand(2, 1, data);
    const sigWithGeneric = this.decodeString(reply, 0);
    // Strip generic info (e.g. "Landroid/app/Activity<TO;>;" → "Landroid/app/Activity;")
    const genericIdx = sigWithGeneric.indexOf("<");
    return genericIdx >= 0 ? sigWithGeneric.substring(0, genericIdx) + sigWithGeneric.substring(sigWithGeneric.lastIndexOf(">") + 1) : sigWithGeneric;
  }

  /** Get methods of a reference type. CommandSet=2, Command=5 */
  async referenceTypeMethods(typeId: bigint): Promise<{ methodId: bigint; name: string; signature: string; modBits: number }[]> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.referenceTypeID);
    this.writeId(data, 0, typeId, sizes.referenceTypeID);
    const reply = await this.sendCommandRaw(2, 5, data);
    let off = 0;
    const count = reply.readInt32BE(off); off += 4;
    const methods: any[] = [];
    for (let i = 0; i < count; i++) {
      const methodId = this.readId(reply, off, sizes.methodID); off += sizes.methodID;
      const name = this.decodeString(reply, off); off += 4 + Buffer.byteLength(name, "utf-8");
      const sig = this.decodeString(reply, off); off += 4 + Buffer.byteLength(sig, "utf-8");
      const modBits = reply.readInt32BE(off); off += 4;
      methods.push({ methodId, name, signature: sig, modBits });
    }
    return methods;
  }

  /** Invoke a method on an object. CommandSet=9, Command=6.
   *  VM must be suspended. Returns the return value (tagged). */
  async invokeMethod(objectId: bigint, threadId: bigint, classTypeId: bigint, methodId: bigint, args?: JdwpValue[]): Promise<JdwpValue> {
    const sizes = this.sizes;
    args = args || [];
    // Calculate payload size: objectID + threadID + classTypeID + methodID + argCount(4) + tagged-args
    let argPayload = 4;
    for (const arg of args) {
      argPayload += 1; // tag byte
      switch (arg.tag) {
        case "byte": argPayload += 1; break;
        case "char": case "short": argPayload += 2; break;
        case "int": case "float": argPayload += 4; break;
        case "long": case "double": argPayload += 8; break;
        case "object": case "array": case "string": argPayload += sizes.objectID; break;
        default: throw new Error(`unsupported arg tag: ${arg.tag}`);
      }
    }
    const data = Buffer.alloc(sizes.objectID + sizes.objectID + sizes.referenceTypeID + sizes.methodID + argPayload);
    let off = 0;
    this.writeId(data, off, objectId, sizes.objectID); off += sizes.objectID;
    this.writeId(data, off, threadId, sizes.objectID); off += sizes.objectID;
    this.writeId(data, off, classTypeId, sizes.referenceTypeID); off += sizes.referenceTypeID;
    this.writeId(data, off, methodId, sizes.methodID); off += sizes.methodID;
    data.writeInt32BE(args.length, off); off += 4;
    for (const arg of args) {
      data[off] = ({ byte: 0x42, char: 0x43, float: 0x46, double: 0x44, int: 0x49, long: 0x4a, short: 0x53, boolean: 0x5a } as any)[arg.tag]
        || (arg.tag === "object" || arg.tag === "array" || arg.tag === "string" ? 0x4c : 0);
      off += 1;
      switch (arg.tag) {
        case "byte": data[off] = arg.value; off += 1; break;
        case "char": data.writeUInt16BE(arg.value, off); off += 2; break;
        case "short": data.writeInt16BE(arg.value, off); off += 2; break;
        case "int": data.writeInt32BE(arg.value, off); off += 4; break;
        case "float": data.writeFloatBE(arg.value, off); off += 4; break;
        case "long": data.writeBigInt64BE(BigInt(arg.value), off); off += 8; break;
        case "double": data.writeDoubleBE(arg.value, off); off += 8; break;
        case "object": case "array": case "string":
          this.writeId(data, off, arg.objectId!, sizes.objectID); off += sizes.objectID; break;
        default: throw new Error(`unsupported arg tag: ${arg.tag}`);
      }
    }
    const reply = await this.sendCommandRaw(9, 6, data);
    // Return value is tagged-value, followed by exception (tagged object)
    return this.decodeValues(reply, 0, 1)[0];
  }

  /** Get the ClassObject for a reference type (used for creating string mirrors). CommandSet=1, Command=11 */
  async createString(utf: string): Promise<bigint> {
    const data = this.encodeString(utf);
    const reply = await this.sendCommand(1, 11, data);
    return this.readId(reply, 0, this.sizes.objectID);
  }

  /** Get array length. CommandSet=13, Command=1 */
  async arrayLength(arrayId: bigint): Promise<number> {
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.objectID);
    this.writeId(data, 0, arrayId, sizes.objectID);
    const reply = await this.sendCommand(13, 1, data);
    return reply.readInt32BE(0);
  }

  /** Get array values. CommandSet=13, Command=2 */
  async arrayValues(arrayId: bigint, firstIndex = 0, length = -1): Promise<JdwpValue[]> {
    if (length < 0) length = await this.arrayLength(arrayId);
    const sizes = this.sizes;
    const data = Buffer.alloc(sizes.objectID + 4 + 4);
    let off = 0;
    this.writeId(data, off, arrayId, sizes.objectID); off += sizes.objectID;
    data.writeInt32BE(firstIndex, off); off += 4;
    data.writeInt32BE(length, off); off += 4;
    const reply = await this.sendCommand(13, 2, data);
    // JDWP spec reply: typeTag(byte) + actualLength(int32) + (tag+value)*
    const tag = reply[0];
    const actualLength = reply.readInt32BE(1);
    const values = this.decodeValues(reply, 5, actualLength);
    return values;
  }

  /** Low-level command: send a JDWP command and return the raw reply data bytes.
   *  Used internally by the high-level API. Also exposed for inspector.ts to extend. */
  async sendCommandRaw(commandSet: number, command: number, data?: Buffer): Promise<Buffer> {
    return this.sendCommand(commandSet, command, data);
  }

  // ── Low-level JDWP packet I/O ──

  private handshake(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const s = this.socket!;
      const timer = setTimeout(() => reject(new Error("handshake timeout")), 5000);
      s.write("JDWP-Handshake");
      s.once("data", (data: Buffer) => {
        clearTimeout(timer);
        resolve(data.toString("ascii", 0, 14) === "JDWP-Handshake");
      });
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async queryIdSizes(): Promise<IdSizes> {
    const reply = await this.sendCommand(1, 7);
    return {
      fieldID: reply.readInt32BE(0),
      methodID: reply.readInt32BE(4),
      objectID: reply.readInt32BE(8),
      referenceTypeID: reply.readInt32BE(12),
      frameID: reply.readInt32BE(16),
    };
  }

  private async sendCommand(commandSet: number, command: number, data?: Buffer): Promise<Buffer> {
    const id = nextPacketId++;
    const packet = this.buildPacket(id, 0, commandSet, command, data ?? Buffer.alloc(0));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket!.write(packet);
    });
  }

  private buildPacket(id: number, flags: number, cmdSet?: number, cmd?: number, data?: Buffer): Buffer {
    const headerLen = 11; // 4+4+1+1+1
    const dataLen = data?.length ?? 0;
    const buf = Buffer.alloc(headerLen + dataLen);
    let off = 0;
    buf.writeInt32BE(headerLen + dataLen, off); off += 4; // length
    buf.writeInt32BE(id, off); off += 4;                  // id
    buf[off] = flags; off += 1;                           // flags
    if (flags === 0 && cmdSet !== undefined && cmd !== undefined) {
      buf[off] = cmdSet; off += 1;
      buf[off] = cmd; off += 1;
    }
    if (data) {
      data.copy(buf, off);
    }
    return buf;
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.tryProcessPackets();
  }

  private tryProcessPackets(): void {
    while (this.buf.length >= 11) {
      const length = this.buf.readInt32BE(0);
      if (this.buf.length < length) break; // wait for more data
      const pkt = this.parsePacket(this.buf.subarray(0, length));
      this.buf = this.buf.subarray(length);

      if (pkt.flags === 0x80) {
        const pending = this.pending.get(pkt.id);
        if (pending) {
          this.pending.delete(pkt.id);
          if (pkt.errorCode && pkt.errorCode !== 0) {
            pending.reject(new Error(`JDWP error ${pkt.errorCode} for packet ${pkt.id}`));
          } else {
            pending.resolve(pkt.data);
          }
        }
      }
      // Ignore events (flags=0 with commandSet that isn't a reply)
    }
  }

  private parsePacket(buf: Buffer): Packet {
    const length = buf.readInt32BE(0);
    const id = buf.readInt32BE(4);
    const flags = buf[8];
    const pkt: Packet = { length, id, flags, data: buf.subarray(11) };
    if (flags === 0x80) {
      pkt.errorCode = buf.readUInt16BE(9);
    } else {
      pkt.commandSet = buf[9];
      pkt.command = buf[10];
    }
    return pkt;
  }

  // ── JDWP type encoding/decoding ──

  private encodeString(s: string): Buffer {
    const utf8 = Buffer.from(s, "utf-8");
    const buf = Buffer.alloc(4 + utf8.length);
    buf.writeInt32BE(utf8.length, 0);
    utf8.copy(buf, 4);
    return buf;
  }

  private decodeString(buf: Buffer, off: number): string {
    const len = buf.readInt32BE(off);
    return buf.toString("utf-8", off + 4, off + 4 + len);
  }

  private readId(buf: Buffer, off: number, size: number): bigint {
    if (size === 4) return BigInt(buf.readUInt32BE(off));
    if (size === 8) return buf.readBigUInt64BE(off);
    throw new Error(`unexpected ID size ${size}`);
  }

  private writeId(buf: Buffer, off: number, val: bigint, size: number): void {
    if (size === 4) {
      buf.writeUInt32BE(Number(val), off);
    } else if (size === 8) {
      buf.writeBigUInt64BE(val, off);
    } else {
      throw new Error(`unexpected ID size ${size}`);
    }
  }

  /** Decode a sequence of JDWP tagged values from a buffer */
  private decodeValues(buf: Buffer, off: number, count: number): JdwpValue[] {
    const sizes = this.sizes;
    const values: JdwpValue[] = [];
    for (let i = 0; i < count; i++) {
      const tag = buf[off]; off += 1;
      switch (tag) {
        case TAG.BYTE:
          values.push({ tag: "byte", value: buf.readInt8(off) }); off += 1; break;
        case TAG.CHAR:
          values.push({ tag: "char", value: buf.readUInt16BE(off) }); off += 2; break;
        case TAG.FLOAT:
          values.push({ tag: "float", value: buf.readFloatBE(off) }); off += 4; break;
        case TAG.DOUBLE:
          values.push({ tag: "double", value: buf.readDoubleBE(off) }); off += 8; break;
        case TAG.INT:
          values.push({ tag: "int", value: buf.readInt32BE(off) }); off += 4; break;
        case TAG.LONG:
          values.push({ tag: "long", value: buf.readBigInt64BE(off) }); off += 8; break;
        case TAG.SHORT:
          values.push({ tag: "short", value: buf.readInt16BE(off) }); off += 2; break;
        case TAG.BOOLEAN:
          values.push({ tag: "boolean", value: buf[off] !== 0 }); off += 1; break;
        case TAG.VOID:
          values.push({ tag: "void" }); break;
        case TAG.OBJECT:
        case TAG.ARRAY:
        case TAG.THREAD:
        case TAG.CLASS_LOADER:
        case TAG.CLASS_OBJECT: {
          const raw = this.readId(buf, off, sizes.objectID);
          off += sizes.objectID;
          if (raw === BigInt(0)) {
            values.push({ tag: tag === TAG.OBJECT ? "object" : tag === TAG.ARRAY ? "array" : "object", objectId: null });
          } else {
            const tagName: Record<number, "object" | "array" | "string" | "thread" | "classLoader" | "classObject"> = {
              0x4c: "object", 0x5b: "array", 0x73: "string",
              0x74: "thread", 0x67: "classLoader", 0x63: "classObject",
            };
            values.push({ tag: tagName[tag] ?? "object", objectId: raw } as JdwpValue);
          }
          break;
        }
        case TAG.STRING: {
          const raw = this.readId(buf, off, sizes.objectID);
          off += sizes.objectID;
          values.push({ tag: "string", objectId: raw }); break;
        }
        default:
          throw new Error(`unknown JDWP value tag 0x${tag.toString(16)} at offset ${off - 1}`);
      }
    }
    return values;
  }
}
