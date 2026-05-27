/**
 * ADB layer: device detection, shell commands, JDWP operations.
 * / ADB 层：设备检测、Shell 命令、JDWP 操作。
 */
import { type Locale } from "./i18n.js";
/**
 * Verify ADB is available in PATH. Throws with platform-specific guidance if not found.
 * / 验证 ADB 是否在 PATH 中，未找到时抛出带平台指导信息的错误。
 */
export declare function checkAdbAvailable(locale?: Locale): void;
/**
 * Auto-detect the first connected device from `adb devices -l`.
 * Returns the serial (first column). Returns undefined if no device is in "device" state.
 * / 从 `adb devices -l` 自动检测第一个已连接的设备，返回序列号。
 */
export declare function findActiveDevice(locale?: Locale): string | undefined;
/**
 * Ensure ADB is available and a serial is selected.
 * If serial not provided, auto-detect and cache.
 * Returns the resolved serial or throws.
 * / 确保 ADB 可用且已选择设备序列号。若未提供则自动检测并缓存。
 */
export declare function ensureAdbAvailable(serial?: string, locale?: Locale): string;
/**
 * Explicitly select (or switch to) a specific device by serial.
 * Validates the device is in "device" state before switching.
 * / 显式切换到一个指定序列号的设备。切换前会验证设备状态为 "device"。
 */
export declare function selectDevice(serial: string, locale?: Locale): void;
/**
 * Run an ADB shell command on the active device.
 * Automatically injects -s <serial> as the first arguments.
 * / 在当前设备上执行 ADB Shell 命令。自动注入 -s <serial> 参数。
 */
export declare function runAdb(args: string[]): string;
/**
 * Run an ADB command without requiring a device serial.
 * Used for device listing, JDWP discovery, etc.
 * / 执行不需要设备序列号的 ADB 命令，用于设备列表、JDWP 发现等。
 */
export declare function runAdbRaw(args: string[]): string;
/**
 * Get the currently active device serial (or undefined if not set).
 * / 获取当前活跃的设备序列号。
 */
export declare function getActiveDeviceSerial(): string | undefined;
/**
 * Dump the current view hierarchy from the device via uiautomator.
 * Returns raw XML string.
 * / 通过 uiautomator 导出当前视图层次结构的原始 XML。
 */
export declare function dumpViewTreeXml(serial?: string): string;
/**
 * List JDWP process IDs from `adb jdwp`.
 * / 通过 `adb jdwp` 列出 JDWP 进程 ID。
 */
export declare function listJdwpPids(serial?: string): number[];
/**
 * Get the package name for a PID via /proc/<pid>/cmdline.
 * / 通过 /proc/<pid>/cmdline 获取进程 ID 对应的包名。
 */
export declare function getPackageName(serial: string, pid: number): string | undefined;
/**
 * List all debuggable processes on the device (from `adb jdwp` + cmdline).
 * / 列出设备上所有可调试的进程（通过 `adb jdwp` + cmdline）。
 */
export declare function listDebuggableProcesses(serial?: string): Array<{
    pid: number;
    package_name?: string;
}>;
/**
 * Forward a local TCP port to a JDWP process via ADB.
 * Returns the serial used and local port for cleanup / handshake.
 * / 通过 ADB 将本地 TCP 端口转发到 JDWP 进程。返回序列号和本地端口用于后续清理/握手。
 */
export declare function forwardJdwp(serial: string | undefined, localPort: number, pid: number): {
    serial: string;
    localPort: number;
};
/**
 * Remove a previously-set ADB port forwarding.
 * / 移除先前设置的 ADB 端口转发。
 */
export declare function removeForward(serial: string, localPort: number): void;
/**
 * Perform the JDWP handshake on a connected local TCP socket.
 * JDWP handshake: sends 14 bytes "JDWP-Handshake" and expects the same back.
 * Returns true if successful.
 * / 在已连接的本地 TCP socket 上执行 JDWP 握手。
 * JDWP 握手：发送 14 字节 "JDWP-Handshake" 并期望收到相同回复。
 */
export declare function jdwpHandshake(port: number): Promise<boolean>;
