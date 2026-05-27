#!/usr/bin/env node

/**
 * Post-install dependency checker.
 * Warns the user if ADB is not found in PATH.
 * / 安装后依赖检查，提示用户 ADB 是否在 PATH 中。
 */

import { execSync } from "child_process";
import { platform } from "os";

const IS_WINDOWS = platform() === "win32";

function yellow(msg) {
  return `\x1b[33m${msg}\x1b[0m`;
}
function cyan(msg) {
  return `\x1b[36m${msg}\x1b[0m`;
}

try {
  if (IS_WINDOWS) {
    try {
      execSync("adb --version", { encoding: "utf-8", stdio: "pipe" });
    } catch {
      execSync("adb.exe --version", { encoding: "utf-8", stdio: "pipe" });
    }
  } else {
    execSync("adb --version", { encoding: "utf-8", stdio: "pipe" });
  }
} catch {
  console.log(`\n${yellow("⚠")} ADB not found in PATH. / PATH 中未找到 ADB。`);
  console.log(`  Install Android SDK Platform Tools:`);
  console.log(`  ${cyan("https://developer.android.com/tools/releases/platform-tools")}`);
  console.log(`  Then add adb to your PATH. / 然后将 adb 加入 PATH。`);
  console.log(`  Run ${yellow("npm run setup")} after ADB is installed to complete setup.\n`);
}
