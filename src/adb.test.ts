import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockExecSync, mockSpawn, mockCreateConnection } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockCreateConnection: vi.fn(),
}));

vi.mock("child_process", () => ({
  execSync: mockExecSync,
  spawn: mockSpawn,
}));

vi.mock("net", () => ({
  createConnection: mockCreateConnection,
}));

type AdbModule = typeof import("./adb.js");

function freshAdb(): Promise<AdbModule> {
  vi.resetModules();
  return import("./adb.js");
}

function mockChildProcess() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  let _killed = false;
  return {
    stdout: {
      on: vi.fn((event: string, cb: (chunk: Buffer) => void) => {
        if (event === "data") handlers["stdout:data"] = cb;
      }),
    },
    stderr: { on: vi.fn() },
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      handlers[event] = cb;
    }),
    get killed() { return _killed; },
    kill: vi.fn(() => { _killed = true; }),
    _emitStdout(chunk: string) {
      handlers["stdout:data"]?.(Buffer.from(chunk, "utf-8"));
    },
    _emitError(err: Error) {
      handlers["error"]?.(err);
    },
    _emitClose() {
      handlers["close"]?.();
    },
  };
}

function mockSocket() {
  const handlers: Record<string, (...args: any[]) => void> = {};
  return {
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
    on: vi.fn((event: string, cb: (...args: any[]) => void) => {
      handlers[event] = cb;
    }),
    _emitConnect() {
      handlers["connect"]?.();
    },
    _emitData(data: string) {
      handlers["data"]?.(Buffer.from(data, "utf-8"));
    },
    _emitError(err: Error) {
      handlers["error"]?.(err);
    },
    _emitClose() {
      handlers["close"]?.();
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LC_MESSAGES = "en_US.UTF-8";
  process.env.LANG = "en_US.UTF-8";
  process.env.LANGUAGE = "en_US.UTF-8";
});

afterEach(() => {
  delete process.env.LC_MESSAGES;
  delete process.env.LANG;
  delete process.env.LANGUAGE;
});

describe("checkAdbAvailable", () => {
  it("does not throw when adb is available", async () => {
    mockExecSync.mockReturnValue("Android Debug Bridge version 1.0.41");
    const adb = await freshAdb();
    expect(() => adb.checkAdbAvailable()).not.toThrow();
    expect(mockExecSync).toHaveBeenCalledWith("adb --version", expect.any(Object));
  });

  it("throws when execSync fails", async () => {
    mockExecSync.mockImplementation(() => { throw new Error("not found"); });
    const adb = await freshAdb();
    expect(() => adb.checkAdbAvailable()).toThrow("ADB not found");
  });

  it("throws with Chinese message when locale is zh", async () => {
    process.env.LC_MESSAGES = "zh_CN.UTF-8";
    process.env.LANG = "zh_CN.UTF-8";
    mockExecSync.mockImplementation(() => { throw new Error("not found"); });
    const adb = await freshAdb();
    expect(() => adb.checkAdbAvailable()).toThrow("未找到 ADB");
  });
});

describe("findActiveDevice", () => {
  const adbVersion = "Android Debug Bridge version 1.0.41";

  it("returns serial of first device in 'device' state", async () => {
    mockExecSync
      .mockReturnValueOnce(adbVersion)
      .mockReturnValueOnce("List of devices attached\nemulator-5554 device\nabc123 device\n");
    const adb = await freshAdb();
    expect(adb.findActiveDevice()).toBe("emulator-5554");
  });

  it("skips non-device-state lines", async () => {
    mockExecSync
      .mockReturnValueOnce(adbVersion)
      .mockReturnValueOnce("List of devices attached\nemulator-5554 offline\nabc123 device\n");
    const adb = await freshAdb();
    expect(adb.findActiveDevice()).toBe("abc123");
  });

  it("returns undefined when no device connected", async () => {
    mockExecSync
      .mockReturnValueOnce(adbVersion)
      .mockReturnValueOnce("List of devices attached\n\n");
    const adb = await freshAdb();
    expect(adb.findActiveDevice()).toBeUndefined();
  });

  it("returns undefined when execSync throws on adb devices", async () => {
    mockExecSync
      .mockReturnValueOnce(adbVersion)
      .mockImplementationOnce(() => { throw new Error("adb error"); });
    const adb = await freshAdb();
    expect(adb.findActiveDevice()).toBeUndefined();
  });
});

describe("ensureAdbAvailable", () => {
  it("returns serial when explicitly provided and device exists", async () => {
    mockExecSync.mockReturnValueOnce("List of devices attached\nabc123 device\n");
    const adb = await freshAdb();
    expect(adb.ensureAdbAvailable("abc123")).toBe("abc123");
  });

  it("throws when explicitly provided serial is not in device state", async () => {
    mockExecSync.mockReturnValueOnce("List of devices attached\nother device\n");
    const adb = await freshAdb();
    expect(() => adb.ensureAdbAvailable("abc123")).toThrow('"abc123"');
  });

  it("throws with wrapped error when execSync fails during validate", async () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error("timeout"); });
    const adb = await freshAdb();
    expect(() => adb.ensureAdbAvailable("abc123")).toThrow("validate");
  });

  it("auto-detects and caches device when no serial provided", async () => {
    const adbVersion = "Android Debug Bridge version 1.0.41";
    mockExecSync
      .mockReturnValueOnce(adbVersion)
      .mockReturnValueOnce("List of devices attached\nemulator-5554 device\n");
    const adb = await freshAdb();
    expect(adb.ensureAdbAvailable()).toBe("emulator-5554");
    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(adb.ensureAdbAvailable()).toBe("emulator-5554");
    expect(mockExecSync).toHaveBeenCalledTimes(2);
  });

  it("throws when no serial and no device found", async () => {
    const adbVersion = "Android Debug Bridge version 1.0.41";
    mockExecSync
      .mockReturnValueOnce(adbVersion)
      .mockReturnValueOnce("List of devices attached\n\n");
    const adb = await freshAdb();
    expect(() => adb.ensureAdbAvailable()).toThrow("No Android device found");
  });

  it("does not update cache when explicit serial is provided", async () => {
    mockExecSync.mockReturnValueOnce("List of devices attached\nabc123 device\n");
    const adb = await freshAdb();
    adb.ensureAdbAvailable("abc123");
    expect(adb.getActiveDeviceSerial()).toBeUndefined();
  });
});

describe("selectDevice", () => {
  it("updates cache when device is valid", async () => {
    mockExecSync.mockReturnValueOnce("List of devices attached\nabc123 device\n");
    const adb = await freshAdb();
    adb.selectDevice("abc123");
    expect(adb.getActiveDeviceSerial()).toBe("abc123");
  });

  it("throws when device is not found", async () => {
    mockExecSync.mockReturnValueOnce("List of devices attached\nother device\n");
    const adb = await freshAdb();
    expect(() => adb.selectDevice("abc123")).toThrow('"abc123"');
  });
});

describe("getActiveDeviceSerial", () => {
  it("returns undefined when no device selected", async () => {
    const adb = await freshAdb();
    expect(adb.getActiveDeviceSerial()).toBeUndefined();
  });

  it("returns cached serial after selectDevice", async () => {
    mockExecSync.mockReturnValueOnce("List of devices attached\nabc123 device\n");
    const adb = await freshAdb();
    adb.selectDevice("abc123");
    expect(adb.getActiveDeviceSerial()).toBe("abc123");
  });
});

describe("runAdb", () => {
  it("runs command with cached serial", async () => {
    mockExecSync
      .mockReturnValueOnce("Android Debug Bridge version 1.0.41")
      .mockReturnValueOnce("List of devices attached\nabc123 device\n")
      .mockReturnValueOnce("shell output");
    const adb = await freshAdb();
    const result = adb.runAdb(["shell", "echo", "hello"]);
    expect(result).toBe("shell output");
    expect(mockExecSync).toHaveBeenLastCalledWith(
      "adb -s abc123 shell echo hello",
      expect.any(Object),
    );
  });
});

describe("runAdbRaw", () => {
  it("runs command without serial and returns output", async () => {
    mockExecSync.mockReturnValueOnce("raw output");
    const adb = await freshAdb();
    expect(adb.runAdbRaw(["devices", "-l"])).toBe("raw output");
    expect(mockExecSync).toHaveBeenCalledWith("adb devices -l", expect.any(Object));
  });
});

describe("dumpViewTreeXml", () => {
  it("runs dump/cat/rm sequence and returns XML content", async () => {
    const fakeXml = '<?xml version="1.0"?><hierarchy><node/></hierarchy>';
    mockExecSync
      .mockReturnValueOnce("List of devices attached\nabc123 device\n")
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(fakeXml)
      .mockReturnValueOnce(undefined);
    const adb = await freshAdb();
    expect(adb.dumpViewTreeXml("abc123")).toBe(fakeXml);
    const calls = mockExecSync.mock.calls.map((c: [string]) => c[0]);
    expect(calls[1]).toContain("uiautomator dump");
    expect(calls[2]).toContain("cat /sdcard/ui.xml");
    expect(calls[3]).toContain("rm /sdcard/ui.xml");
  });
});

describe("listJdwpPids", () => {
  it("resolves with parsed PIDs from stdout", async () => {
    const child = mockChildProcess();
    mockSpawn.mockReturnValueOnce(child);
    mockExecSync.mockReturnValueOnce("List of devices attached\nabc123 device\n");
    const adb = await freshAdb();
    const promise = adb.listJdwpPids("abc123");
    child._emitStdout("1234\n5678\n");
    child._emitClose();
    expect(await promise).toEqual([1234, 5678]);
  });

  it("resolves with empty array when no data", async () => {
    const child = mockChildProcess();
    mockSpawn.mockReturnValueOnce(child);
    mockExecSync.mockReturnValueOnce("List of devices attached\nabc123 device\n");
    const adb = await freshAdb();
    const promise = adb.listJdwpPids("abc123");
    child._emitClose();
    expect(await promise).toEqual([]);
  });

  it("rejects on spawn error", async () => {
    const child = mockChildProcess();
    mockSpawn.mockReturnValueOnce(child);
    mockExecSync.mockReturnValueOnce("List of devices attached\nabc123 device\n");
    const adb = await freshAdb();
    const promise = adb.listJdwpPids("abc123");
    child._emitError(new Error("spawn failed"));
    await expect(promise).rejects.toThrow("adb jdwp failed");
  });
});

describe("getPackageName", () => {
  it("returns package name from /proc/pid/cmdline", async () => {
    mockExecSync.mockReturnValueOnce("com.example.app\0flag\0");
    const adb = await freshAdb();
    expect(adb.getPackageName("abc123", 1234)).toBe("com.example.app");
    expect(mockExecSync).toHaveBeenCalledWith(
      "adb -s abc123 shell cat /proc/1234/cmdline",
      expect.any(Object),
    );
  });

  it("returns undefined when cmdline has no content before null", async () => {
    mockExecSync.mockReturnValueOnce("\0");
    const adb = await freshAdb();
    expect(adb.getPackageName("abc123", 9999)).toBeUndefined();
  });

  it("returns undefined when execSync throws", async () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error("no process"); });
    const adb = await freshAdb();
    expect(adb.getPackageName("abc123", 9999)).toBeUndefined();
  });
});

describe("listDebuggableProcesses", () => {
  it("returns combined pid and package info", async () => {
    const child = mockChildProcess();
    mockSpawn.mockReturnValueOnce(child);
    mockExecSync
      .mockReturnValueOnce("List of devices attached\nabc123 device\n")
      .mockReturnValueOnce("List of devices attached\nabc123 device\n")
      .mockReturnValueOnce("com.example.app\0")
      .mockReturnValueOnce("com.other.app\0");
    const adb = await freshAdb();
    const promise = adb.listDebuggableProcesses("abc123");
    child._emitStdout("111\n222\n");
    child._emitClose();
    expect(await promise).toEqual([
      { pid: 111, package_name: "com.example.app" },
      { pid: 222, package_name: "com.other.app" },
    ]);
  });

  it("handles when getPackageName returns undefined", async () => {
    const child = mockChildProcess();
    mockSpawn.mockReturnValueOnce(child);
    mockExecSync
      .mockReturnValueOnce("List of devices attached\nabc123 device\n")
      .mockReturnValueOnce("List of devices attached\nabc123 device\n")
      .mockImplementationOnce(() => { throw new Error("no process"); });
    const adb = await freshAdb();
    const promise = adb.listDebuggableProcesses("abc123");
    child._emitStdout("333\n");
    child._emitClose();
    expect(await promise).toEqual([{ pid: 333, package_name: undefined }]);
  });
});

describe("forwardJdwp", () => {
  it("forwards port and returns details", async () => {
    mockExecSync
      .mockReturnValueOnce("List of devices attached\nabc123 device\n")
      .mockReturnValueOnce(undefined);
    const adb = await freshAdb();
    const result = adb.forwardJdwp("abc123", 8700, 1234);
    expect(result).toEqual({ serial: "abc123", localPort: 8700 });
    expect(mockExecSync).toHaveBeenLastCalledWith(
      "adb -s abc123 forward tcp:8700 jdwp:1234",
      expect.any(Object),
    );
  });
});

describe("removeForward", () => {
  it("removes forward without throwing", async () => {
    mockExecSync.mockReturnValueOnce(undefined);
    const adb = await freshAdb();
    expect(() => adb.removeForward("abc123", 8700)).not.toThrow();
  });

  it("silently ignores when removal fails", async () => {
    mockExecSync.mockImplementationOnce(() => { throw new Error("already removed"); });
    const adb = await freshAdb();
    expect(() => adb.removeForward("abc123", 8700)).not.toThrow();
  });
});

describe("jdwpHandshake", () => {
  it("returns true on successful handshake", async () => {
    const socket = mockSocket();
    mockCreateConnection.mockImplementation(() => socket);
    const adb = await freshAdb();
    const promise = adb.jdwpHandshake(8700);
    socket._emitConnect();
    socket._emitData("JDWP-Handshake");
    expect(await promise).toBe(true);
    expect(socket.write).toHaveBeenCalledWith("JDWP-Handshake");
  });

  it("returns false on wrong handshake response", async () => {
    const socket = mockSocket();
    mockCreateConnection.mockImplementation(() => socket);
    const adb = await freshAdb();
    const promise = adb.jdwpHandshake(8700);
    socket._emitConnect();
    socket._emitData("WRONG-RESPONSE");
    expect(await promise).toBe(false);
  });

  it("returns false on socket error", async () => {
    const socket = mockSocket();
    mockCreateConnection.mockImplementation((_opts: any, _cb: () => void) => {
      return socket;
    });
    const adb = await freshAdb();
    const promise = adb.jdwpHandshake(8700);
    socket._emitError(new Error("connection refused"));
    expect(await promise).toBe(false);
  });

  it("returns false on socket close without data", async () => {
    const socket = mockSocket();
    mockCreateConnection.mockImplementation((_opts: any, _cb: () => void) => {
      return socket;
    });
    const adb = await freshAdb();
    const promise = adb.jdwpHandshake(8700);
    socket._emitClose();
    expect(await promise).toBe(false);
  });
});
