/**
 * ADB layer: device detection, shell commands, JDWP operations.
 * / ADB 层：设备检测、Shell 命令、JDWP 操作。
 */
import { execSync, spawn } from "child_process";
import { createConnection } from "net";
import { platform } from "os";
import { t, detectLocale } from "./i18n.js";
/** Platform detection / 平台检测 */
const IS_WINDOWS = platform() === "win32";
/**
 * Verify ADB is available in PATH. Throws with platform-specific guidance if not found.
 * / 验证 ADB 是否在 PATH 中，未找到时抛出带平台指导信息的错误。
 */
export function checkAdbAvailable(locale) {
    const lang = locale ?? detectLocale();
    try {
        execSync("adb --version", { encoding: "utf-8", stdio: "pipe" });
    }
    catch {
        throw new Error(t(lang, "adb.not_found"));
    }
}
// Cached auto-detected device serial / 缓存的自动检测设备序列号
let _deviceSerial;
/**
 * Auto-detect the first connected device from `adb devices -l`.
 * Returns the serial (first column). Returns undefined if no device is in "device" state.
 * / 从 `adb devices -l` 自动检测第一个已连接的设备，返回序列号。
 */
export function findActiveDevice(locale) {
    const lang = locale ?? detectLocale();
    checkAdbAvailable(lang);
    try {
        const out = execSync("adb devices -l", { encoding: "utf-8" });
        const lines = out.split("\n").slice(1);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const parts = trimmed.split(/\s+/);
            if (parts[1] === "device") {
                return parts[0];
            }
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Ensure ADB is available and a serial is selected.
 * If serial not provided, auto-detect and cache.
 * If serial is explicitly provided, validate but DON'T update cache
 * (avoids cross-agent interference when multiple agents share one MCP server).
 * Returns the resolved serial or throws.
 * / 确保 ADB 可用且已选择设备序列号。若未提供则自动检测并缓存。
 *   若显式传了 serial，只做校验不改缓存，避免多 agent 共享 MCP 进程时串号。
 */
export function ensureAdbAvailable(serial, locale) {
    const lang = locale ?? detectLocale();
    if (serial) {
        // Validate but DON'T update cache — explicit serial is per-call
        // / 只校验不改缓存 — 显式 serial 每次独立
        validateDevice(serial, lang);
        return serial;
    }
    if (_deviceSerial)
        return _deviceSerial;
    const detected = findActiveDevice(lang);
    if (!detected) {
        throw new Error(t(lang, "device.not_found"));
    }
    _deviceSerial = detected;
    return _deviceSerial;
}
/**
 * Validate that a device serial is reachable and in "device" state, without touching cache.
 * / 验证设备可达且状态为 "device"，不改缓存。
 */
function validateDevice(serial, locale) {
    try {
        const out = execSync("adb devices -l", { encoding: "utf-8" });
        const lines = out.split("\n").slice(1);
        const found = lines.some(line => {
            const parts = line.trim().split(/\s+/);
            return parts[0] === serial && parts[1] === "device";
        });
        if (!found) {
            throw new Error(t(locale, "device.invalid_state", { serial }));
        }
    }
    catch (e) {
        if (e.message?.includes?.(t(locale, "device.invalid_state", { serial }).slice(0, 10)))
            throw e;
        throw new Error(t(locale, "device.validate_failed", { serial, reason: e.message || String(e) }));
    }
}
/**
 * Explicitly select (or switch to) a specific device by serial.
 * Validates the device is in "device" state before switching.
 * NOTE: This DOES update the cache (intentionally — its purpose is to switch).
 * Most callers should use ensureAdbAvailable(serial) instead.
 * / 显式切换到一个指定序列号的设备。切换前会验证设备状态为 "device"。
 *   注意：这会修改缓存（切换设备本就是目的）。大多数调用方应改用 ensureAdbAvailable(serial)。
 */
export function selectDevice(serial, locale) {
    const lang = locale ?? detectLocale();
    try {
        const out = execSync("adb devices -l", { encoding: "utf-8" });
        const lines = out.split("\n").slice(1);
        const found = lines.some(line => {
            const parts = line.trim().split(/\s+/);
            return parts[0] === serial && parts[1] === "device";
        });
        if (!found) {
            throw new Error(t(lang, "device.invalid_state", { serial }));
        }
        _deviceSerial = serial;
    }
    catch (e) {
        if (e.message?.includes?.(t(lang, "device.invalid_state", { serial }).slice(0, 10)))
            throw e;
        throw new Error(t(lang, "device.validate_failed", { serial, reason: e.message || String(e) }));
    }
}
/**
 * Run an ADB shell command on the active device.
 * Automatically injects -s <serial> as the first arguments.
 * / 在当前设备上执行 ADB Shell 命令。自动注入 -s <serial> 参数。
 */
export function runAdb(args) {
    const serial = ensureAdbAvailable();
    return execSync(`adb -s ${serial} ${args.join(" ")}`, { encoding: "utf-8" });
}
/**
 * Run an ADB command without requiring a device serial.
 * Used for device listing, JDWP discovery, etc.
 * / 执行不需要设备序列号的 ADB 命令，用于设备列表、JDWP 发现等。
 */
export function runAdbRaw(args) {
    return execSync(`adb ${args.join(" ")}`, { encoding: "utf-8" });
}
/**
 * Get the currently active device serial (or undefined if not set).
 * / 获取当前活跃的设备序列号。
 */
export function getActiveDeviceSerial() {
    return _deviceSerial;
}
/**
 * Dump the current view hierarchy from the device via uiautomator.
 * Returns raw XML string.
 * / 通过 uiautomator 导出当前视图层次结构的原始 XML。
 */
export function dumpViewTreeXml(serial) {
    const resolvedSerial = ensureAdbAvailable(serial);
    execSync(`adb -s ${resolvedSerial} shell uiautomator dump /sdcard/ui.xml`, {
        encoding: "utf-8",
        timeout: 5000,
    });
    const xml = execSync(`adb -s ${resolvedSerial} shell cat /sdcard/ui.xml`, {
        encoding: "utf-8",
        timeout: 5000,
    });
    execSync(`adb -s ${resolvedSerial} shell rm /sdcard/ui.xml`, {
        encoding: "utf-8",
    });
    return xml;
}
/**
 * List JDWP process IDs from `adb jdwp`.
 *
 * `adb jdwp` never terminates — it streams PIDs continuously.
 * Use spawn + quiet-period flush: collect the initial batch, then kill after idle.
 * / `adb jdwp` 不会退出，持续推送 PID。使用 spawn + 静默超时策略收集首批 PID。
 */
export function listJdwpPids(serial) {
    const resolvedSerial = ensureAdbAvailable(serial);
    return new Promise((resolve, reject) => {
        const child = spawn("adb", ["-s", resolvedSerial, "jdwp"], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let data = "";
        let flushTimer = null;
        const flush = () => {
            if (flushTimer)
                clearTimeout(flushTimer);
            if (!child.killed)
                child.kill();
            const pids = data
                .split("\n")
                .map(line => parseInt(line.trim(), 10))
                .filter(pid => !isNaN(pid));
            resolve(pids);
        };
        child.stdout.on("data", (chunk) => {
            data += chunk.toString("utf-8");
            if (flushTimer)
                clearTimeout(flushTimer);
            flushTimer = setTimeout(flush, 300); // flush 300ms after last data / 最后一批数据后 300ms 关闭
        });
        child.stderr.on("data", () => {
            // ignore stderr
        });
        child.on("error", (err) => {
            if (flushTimer)
                clearTimeout(flushTimer);
            reject(new Error(`adb jdwp failed: ${err.message}`));
        });
        child.on("close", () => {
            flush();
        });
        // Safety: force flush after 3s even if data keeps streaming (e.g. app restart spam)
        // / 兜底：3s 后强制关闭，防止数据持续流（如频繁重启调试进程）
        setTimeout(() => {
            flush();
        }, 3000);
    });
}
/**
 * Get the package name for a PID via /proc/<pid>/cmdline.
 * / 通过 /proc/<pid>/cmdline 获取进程 ID 对应的包名。
 */
export function getPackageName(serial, pid) {
    try {
        const out = execSync(`adb -s ${serial} shell cat /proc/${pid}/cmdline`, {
            encoding: "utf-8",
        });
        return out.split("\0")[0]?.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * List all debuggable processes on the device (from `adb jdwp` + cmdline).
 * / 列出设备上所有可调试的进程（通过 `adb jdwp` + cmdline）。
 */
export async function listDebuggableProcesses(serial) {
    const resolvedSerial = ensureAdbAvailable(serial);
    const pids = await listJdwpPids(resolvedSerial);
    return pids.map(pid => ({
        pid,
        package_name: getPackageName(resolvedSerial, pid),
    }));
}
/**
 * Forward a local TCP port to a JDWP process via ADB.
 * Returns the serial used and local port for cleanup / handshake.
 * / 通过 ADB 将本地 TCP 端口转发到 JDWP 进程。返回序列号和本地端口用于后续清理/握手。
 */
export function forwardJdwp(serial, localPort, pid) {
    const resolvedSerial = ensureAdbAvailable(serial);
    execSync(`adb -s ${resolvedSerial} forward tcp:${localPort} jdwp:${pid}`, {
        encoding: "utf-8",
    });
    return { serial: resolvedSerial, localPort };
}
/**
 * Remove a previously-set ADB port forwarding.
 * / 移除先前设置的 ADB 端口转发。
 */
export function removeForward(serial, localPort) {
    try {
        execSync(`adb -s ${serial} forward --remove tcp:${localPort}`, {
            encoding: "utf-8",
        });
    }
    catch {
        // ignore if already removed / 如果已经移除则忽略
    }
}
/**
 * Perform the JDWP handshake on a connected local TCP socket.
 * JDWP handshake: sends 14 bytes "JDWP-Handshake" and expects the same back.
 * Returns true if successful.
 * / 在已连接的本地 TCP socket 上执行 JDWP 握手。
 * JDWP 握手：发送 14 字节 "JDWP-Handshake" 并期望收到相同回复。
 */
export function jdwpHandshake(port) {
    return new Promise((resolve) => {
        const client = createConnection({ port, host: "127.0.0.1" });
        client.on("connect", () => {
            client.write("JDWP-Handshake");
        });
        client.on("data", (data) => {
            const received = data.toString("utf-8").trim();
            client.end();
            resolve(received === "JDWP-Handshake");
        });
        client.on("error", () => resolve(false));
        client.on("close", () => resolve(false));
        setTimeout(() => {
            client.destroy();
            resolve(false);
        }, 5000);
    });
}
//# sourceMappingURL=adb.js.map