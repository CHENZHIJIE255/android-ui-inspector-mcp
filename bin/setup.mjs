#!/usr/bin/env node

/**
 * Cross-platform setup script for android-ui-inspector-mcp.
 *
 * 1. Checks prerequisites (Node.js, ADB)
 * 2. Builds the project
 * 3. Registers the MCP server in opencode.json
 * 4. Prints instructions for `npm link`
 *
 * / 跨平台安装脚本：
 * 1. 检查前置依赖（Node.js、ADB）
 * 2. 构建项目
 * 3. 在 opencode.json 中注册 MCP 服务器
 * 4. 提示使用 `npm link`
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname, join } from "path";
import { homedir, platform } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");

const PLATFORM = platform();
const IS_WINDOWS = PLATFORM === "win32";
const IS_MAC = PLATFORM === "darwin";

function green(msg) {
  return `\x1b[32m${msg}\x1b[0m`;
}
function yellow(msg) {
  return `\x1b[33m${msg}\x1b[0m`;
}
function red(msg) {
  return `\x1b[31m${msg}\x1b[0m`;
}
function cyan(msg) {
  return `\x1b[36m${msg}\x1b[0m`;
}

function log(label, msg) {
  console.log(`${green("[" + label + "]")} ${msg}`);
}

function warn(label, msg) {
  console.log(`${yellow("[" + label + "]")} ${msg}`);
}

function error(label, msg) {
  console.log(`${red("[" + label + "]")} ${msg}`);
}

/**
 * Find ADB executable in PATH.
 * On Windows, also checks for adb.exe.
 * / 在 PATH 中查找 ADB 可执行文件，Windows 下额外检查 adb.exe。
 */
function findAdb() {
  try {
    execSync("adb --version", { encoding: "utf-8", stdio: "pipe" });
    return "adb";
  } catch {
    if (IS_WINDOWS) {
      try {
        execSync("adb.exe --version", { encoding: "utf-8", stdio: "pipe" });
        return "adb.exe";
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Resolve the opencode config path for the current platform.
 * / 获取当前平台下的 opencode 配置路径。
 */
function getOpenCodeConfigPath() {
  const home = homedir();
  if (IS_WINDOWS) {
    // On Windows, check APPDATA first, then XDG-style ~/.config
    const appData = process.env.APPDATA;
    if (appData) {
      const p = join(appData, "opencode", "opencode.json");
      if (existsSync(p)) return p;
    }
  }
  return join(home, ".config", "opencode", "opencode.json");
}

/**
 * Check Node.js version / 检查 Node.js 版本
 */
function checkNode() {
  const nodeVer = process.version;
  const major = parseInt(nodeVer.slice(1).split(".")[0], 10);
  if (major < 18) {
    error("PREREQ", `Node.js >= 18 required, found ${nodeVer}`);
    process.exit(1);
  }
  log("PREREQ", `Node.js ${nodeVer} ${green("✓")}`);
}

/**
 * Check ADB is available / 检查 ADB 是否可用
 */
function checkAdb() {
  const adb = findAdb();
  if (!adb) {
    warn("PREREQ", `ADB not found in PATH. / PATH 中未找到 ADB`);
    warn("PREREQ", `Install Android SDK Platform Tools: https://developer.android.com/tools/releases/platform-tools`);
    warn("PREREQ", "安装 Android SDK Platform Tools 并将 adb 加入 PATH");
    return false;
  }
  log("PREREQ", `${adb} ${green("✓")}`);
  return true;
}

/**
 * Run npm install if node_modules missing / 若 node_modules 不存在则运行 npm install
 */
function ensureDeps() {
  if (!existsSync(join(PROJECT_ROOT, "node_modules"))) {
    log("DEPS", "Installing dependencies... / 安装依赖...");
    execSync("npm install", { cwd: PROJECT_ROOT, stdio: "inherit" });
    log("DEPS", `${green("✓")} Dependencies installed / 依赖安装完成`);
  } else {
    log("DEPS", `${green("✓")} Dependencies already installed / 依赖已安装`);
  }
}

/**
 * Build the TypeScript project / 构建 TypeScript 项目
 */
function build() {
  log("BUILD", "Building project... / 构建项目...");
  try {
    execSync("npm run build", { cwd: PROJECT_ROOT, stdio: "inherit" });
    log("BUILD", `${green("✓")} Build successful / 构建成功`);
  } catch {
    error("BUILD", "Build failed. / 构建失败。");
    process.exit(1);
  }
}

/**
 * Register (or update) the MCP server entry in opencode.json.
 * / 在 opencode.json 中注册（或更新）MCP 服务器配置。
 */
function registerMcp() {
  const configPath = getOpenCodeConfigPath();
  const configDir = dirname(configPath);

  log("MCP", `Config path: ${configPath}`);

  // Read existing config or start fresh
  let config = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (e) {
      warn("MCP", `Failed to parse existing config, will overwrite. / 解析现有配置失败，将覆盖写入。`);
      config = {};
    }
  }

  // Build the server entry path using the dist/index.js
  const serverScript = join(PROJECT_ROOT, "dist", "index.js");
  // Normalize path separators for the platform
  const normalizedPath = serverScript.split("\\").join("/");

  // Ensure mcp section exists
  if (!config.mcp) config.mcp = {};

  config.mcp["android-ui-inspector"] = {
    command: [
      "node",
      normalizedPath,
    ],
    enabled: true,
    type: "local",
  };

  // Write back
  try {
    // Ensure config directory exists
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    log("MCP", `${green("✓")} Server registered in opencode.json / 已注册到 opencode.json`);
  } catch (e) {
    error("MCP", `Failed to write config: ${e.message}`);
    process.exit(1);
  }
}

/**
 * Attempt npm link, fall back gracefully on permission errors.
 * / 尝试 npm link，权限错误时优雅降级。
 */
function tryNpmLink() {
  log("LINK", "Attempting npm link... / 尝试 npm link...");
  try {
    execSync("npm link", { cwd: PROJECT_ROOT, stdio: ["pipe", "pipe", "pipe"] });
    log("LINK", `${green("✓")} npm link successful — server is globally available as ${yellow("android-ui-inspector-mcp")}`);
    return true;
  } catch (e) {
    const msg = e.stderr?.toString() || e.message || "";
    if (msg.includes("EACCES") || msg.includes("permission denied")) {
      warn("LINK", "npm link requires root permissions on this system.");
      warn("LINK", "The server is already registered in opencode.json with an absolute path.");
      warn("LINK", "To enable global command usage, run: sudo npm link");
    } else {
      warn("LINK", `npm link failed (non-critical): ${msg.slice(0, 100)}`);
    }
    return false;
  }
}

/**
 * Print post-setup instructions / 打印安装后指南
 */
function printInstructions(linked) {
  console.log("\n" + cyan("═══════════════════════════════════════════"));
  console.log(cyan("  Next steps / 下一步："));
  console.log(cyan("═══════════════════════════════════════════"));
  console.log(``);

  if (linked) {
    console.log(`  ${green("✓")} Server globally available as ${yellow("android-ui-inspector-mcp")}`);
  } else {
    console.log(`  ${green("1.")} (Optional) Make server globally available:`);
    console.log(`     ${yellow("sudo npm link")}`);
    console.log(``);
    console.log(`     Or set a user-level npm prefix:`);
    console.log(`     ${yellow("npm config set prefix ~/.npm-global")}`);
    console.log(`     ${yellow("npm link")}`);
    console.log(``);
  }

  console.log(`  ${green("2.")} Restart OpenCode to use the MCP server.`);
  console.log(`     The server is registered in your opencode.json.`);
  console.log(``);
  console.log(`  ${green("3.")} Verify the server starts:`);
  console.log(`     ${yellow(`node "${normalizedPathForDisplay()}"`)}`);
  console.log(`     Then send it a JSON message, or check the OpenCode logs.`);
  console.log(``);
  console.log(cyan("═══════════════════════════════════════════\n"));
}

function normalizedPathForDisplay() {
  const p = join(PROJECT_ROOT, "dist", "index.js");
  return p.split("\\").join("/");
}

// ────────────────────────────────────
// Main
// ────────────────────────────────────
console.log(`\n${cyan("android-ui-inspector-mcp")} setup / 安装向导\n`);

checkNode();
checkAdb();
ensureDeps();
build();
registerMcp();
const linked = tryNpmLink();
printInstructions(linked);

console.log(`Setup complete! / 安装完成！${green("🎉")}\n`);
