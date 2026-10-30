import { execFile } from 'child_process';
import type { ExecFileException } from 'child_process';
import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import pLimit from 'p-limit';
import { backgroundMode, effectiveActivation } from './background-policy.js';
import { acquireLease, hasCompletionReceipt } from './execution-lease.js';
import { assertExtendScriptSyntax } from './script-syntax.js';
import { nativeFailureKind } from './native-failure.js';
import type { TempFiles } from './file-transport.js';
import { preserveTemporaryFiles } from './file-transport.js';
import {
  createTempFiles,
  writeParams,
  writeJsx,
  writeAppleScript,
  writePowerShellScript,
  readResult,
  cleanupTempFiles,
} from './file-transport.js';

// Illustrator はシングルスレッド — JSX 実行を直列化
const jsxLimit = pLimit(1);

// 実行中の JSX を追跡（グレースフルシャットダウン用）
let pendingCount = 0;
let pendingResolvers: Array<() => void> = [];

// ─── トランスポート選択 ───────────────────────────────────────────────────────
//
//  ILLUSTRATOR_MCP_TRANSPORT=osascript → macOS AppleScript (macOS 強制)
//  未設定:
//    darwin  → osascript
//    win32   → PowerShell COM
//
export type Transport = 'osascript' | 'powershell';

export function resolveTransport(
  platform: string = process.platform,
  envVar: string | undefined = process.env['ILLUSTRATOR_MCP_TRANSPORT'],
): Transport {
  if (envVar === 'osascript') return 'osascript';
  if (envVar === 'powershell') return 'powershell';
  if (platform === 'darwin') return 'osascript';
  if (platform === 'win32') return 'powershell';
  throw new Error(`Unsupported platform: ${platform}. Only macOS and Windows are supported.`);
}

// 遅延初期化: テスト環境 (Linux CI) ではモジュール読み込み時に throw しないようにする
let _transport: Transport | null = null;
function getTransport(): Transport {
  if (!_transport) _transport = resolveTransport();
  return _transport;
}

// ─── アプリパス解決 ─────────────────────────────────────────────────────────
//
//  会話で set_illustrator_version ツールを使ってバージョンを指定すると、
//  そのセッション中は指定バージョンの Illustrator に接続する。
//  未指定時はデフォルトの "Adobe Illustrator" に接続。
//
//  macOS: フルパスで tell するため、複数バージョン同時起動時も正しく接続。
//  Windows: COM ProgID にバージョン区別がないため、複数同時起動時の切り替えは不可。
//

/**
 * バージョン番号（例: "2025"）からアプリのフルパスを解決する。
 */
export function resolveVersionToPath(
  version: string,
  platform: string = process.platform,
): string {
  if (platform === 'darwin') {
    return `/Applications/Adobe Illustrator ${version}/Adobe Illustrator.app`;
  }
  if (platform === 'win32') {
    return `C:\\Program Files\\Adobe\\Adobe Illustrator ${version}\\Support Files\\Contents\\Windows\\Illustrator.exe`;
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

// セッション中のアプリパス（set_illustrator_version で設定）
let _sessionAppPath: string | undefined;

/**
 * セッションのアプリパスを設定する。
 * version が指定された場合はパスに変換、undefined で解除。
 */
export function setAppVersion(version: string | undefined, platform?: string): void {
  _sessionAppPath = version ? resolveVersionToPath(version, platform) : undefined;
}

/**
 * セッションのアプリパスを取得する。
 */
export function getAppPath(): string | undefined {
  return _sessionAppPath || process.env.ILLUSTRATOR_MCP_APP_PATH;
}

/**
 * 現在設定されているバージョン情報を返す（ステータス表示用）。
 */
export function getAppVersion(): string | undefined {
  if (!_sessionAppPath) return undefined;
  const match = _sessionAppPath.match(/Illustrator (\d{4})/);
  return match ? match[1] : undefined;
}

/**
 * 実行中の JSX がすべて完了するまで待機する（シャットダウン用）
 */
export function waitForPendingExecutions(): Promise<void> {
  if (pendingCount === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    pendingResolvers.push(resolve);
  });
}

// ESM (dist/executor/jsx-runner.js) → ../jsx/helpers/common.jsx
// CJS bundle (dist/bundle.cjs)     → ./jsx/helpers/common.jsx
const __dir = path.dirname(fileURLToPath(import.meta.url));
const _esmCandidate = path.resolve(__dir, '../jsx/helpers/common.jsx');
const _cjsCandidate = path.resolve(__dir, 'jsx/helpers/common.jsx');
const JSX_HELPERS_PATH = existsSync(_esmCandidate) ? _esmCandidate : _cjsCandidate;

// helpers ファイルをメモリにキャッシュ（毎回のディスク読み込みを排除）
let _helpersCache: string | null = null;
async function getHelpers(): Promise<string> {
  if (!_helpersCache) {
    _helpersCache = await fs.readFile(JSX_HELPERS_PATH, 'utf-8');
  }
  return _helpersCache;
}

// タイムアウト設定（ms）
const TIMEOUT_NORMAL = 30_000;
const TIMEOUT_HEAVY = 60_000;

export interface JsxResult {
  error?: boolean;
  message?: string;
  line?: number;
  [key: string]: unknown;
}

/**
 * osascript / PowerShell COM 用 JSX ビルダー（ファイルベース I/O）
 */
async function buildJsx(
  toolScript: string,
  paramsPath: string,
  resultPath: string,
  receiptPath: string,
  executionId: string,
): Promise<string> {
  const helpers = await getHelpers();
  return `(function() {
${helpers}
var PARAMS_PATH = ${JSON.stringify(paramsPath)};
var RESULT_PATH = ${JSON.stringify(resultPath)};
var MCP_BACKGROUND = ${backgroundMode() ? 'true' : 'false'};
var JSON = { stringify: jsonStringify, parse: jsonParse };
var __previousInteraction = app.userInteractionLevel;
try {
  if (MCP_BACKGROUND) app.userInteractionLevel = UserInteractionLevel.DONTDISPLAYALERTS;
${toolScript}
} catch (__unexpectedError) {
  writeResultFile(RESULT_PATH, { error: true, message: String(__unexpectedError.message || __unexpectedError), line: __unexpectedError.line });
} finally {
  try { app.userInteractionLevel = __previousInteraction; } finally {
    var __receipt = new File(${JSON.stringify(receiptPath)});
    __receipt.encoding = "UTF-8";
    if (__receipt.open("w")) { __receipt.write(${JSON.stringify(JSON.stringify({ native_completed: true, execution_id: executionId }))}); __receipt.close(); }
  }
}
})();`;
}

// ─── エラーメッセージ変換 ────────────────────────────────────────────────────

function parseOsascriptError(stderr: string): string {
  if (stderr.includes('Connection is invalid')) {
    return 'Illustrator is not running. Please launch Adobe Illustrator.';
  }
  if (stderr.includes('not allowed to send keystrokes') || stderr.includes('not allowed assistive access')) {
    return 'Automation permission denied. Please allow access in System Settings > Privacy & Security > Automation.';
  }
  return stderr;
}

function parsePowerShellError(stderr: string): string {
  if (stderr.includes('Cannot create ActiveX component') || stderr.includes('80080005') || stderr.includes('80040154')) {
    return 'Illustrator is not running or is not installed. Please launch Adobe Illustrator.';
  }
  return stderr;
}

export function getExecFailureMessage(
  error: ExecFileException,
  stderr: string,
  timeout: number,
  transport: Transport = 'osascript',
): string {
  if (error.code === 'ETIMEDOUT') {
    return `Script execution timed out after ${timeout}ms`;
  }
  if (error.killed) {
    return `Script execution was terminated${error.signal ? ` by signal ${error.signal}` : ''}`;
  }
  if (transport === 'powershell') return parsePowerShellError(stderr || error.message);
  return parseOsascriptError(stderr || error.message);
}

// ─── 各トランスポートの実行ロジック ─────────────────────────────────────────

async function executeViaTransport(
  transport: Transport, jsxCode: string, params: unknown, timeout: number, activate: boolean,
): Promise<JsxResult> {
  assertExtendScriptSyntax(jsxCode);
  const lease = await acquireLease();
  let files: TempFiles | undefined;
  let submitted = false;
  let confirmed = false;
  let failure = '';
  let failureKind = 'execution_unconfirmed';
  try {
    files = createTempFiles();
    await lease.update({ artifacts: files, transport });
    await writeParams(files.paramsPath, params);
    const fullJsx = await buildJsx(jsxCode, files.paramsPath, files.resultPath, lease.record.receipt, lease.record.id);
    assertExtendScriptSyntax(fullJsx);
    await writeJsx(files.scriptPath, fullJsx);
    if (transport === 'osascript') {
      // The process timeout below stays the authority; the AppleEvent must outlive it.
      await writeAppleScript(files.runnerPath, files.scriptPath, { activate: effectiveActivation(activate), appPath: getAppPath(), timeoutSeconds: timeout / 1000 + 30 });
    } else {
      await writePowerShellScript(files.runnerPath, files.scriptPath, { activate: effectiveActivation(activate), appPath: getAppPath() });
    }
    const command = transport === 'osascript' ? 'osascript' : 'powershell.exe';
    const args = transport === 'osascript' ? [files.runnerPath] : ['-ExecutionPolicy', 'Bypass', '-NonInteractive', '-File', files.runnerPath];
    await new Promise<void>((resolve, reject) => {
      submitted = true;
      execFile(command, args, { timeout }, (error, _stdout, stderr) => {
        if (error) {
          failureKind = nativeFailureKind(error, stderr);
          confirmed = failureKind !== 'execution_unconfirmed';
          reject(new Error(getExecFailureMessage(error, stderr, timeout, transport)));
        } else resolve();
      });
    });
    confirmed = true;
    failureKind = 'result_error';
    return await readAndValidateResult(files.resultPath);
  } catch (error) {
    failure = String(error);
    if (!submitted) { confirmed = true; failureKind = 'pre_execution_error'; }
    throw new Error(`${failure}\nExecution: ${lease.record.id}\nDiagnostics: ${path.join(path.dirname(lease.record.receipt), '..', 'executions', lease.record.id + '.json')}`, { cause: error });
  } finally {
    confirmed = confirmed || await hasCompletionReceipt(lease.record);
    if (failure || !confirmed) preserveTemporaryFiles();
    // Record completion before optional cleanup. A cleanup error must not strand ownership.
    await lease.finish(confirmed, failure, failure ? failureKind : undefined);
    if (confirmed && !failure && files) await cleanupTempFiles(files);
  }
}

async function readAndValidateResult(resultPath: string): Promise<JsxResult> {
  let result: JsxResult;
  try {
    result = await readResult(resultPath) as JsxResult;
  } catch {
    throw new Error(
      'JSX terminated without producing a result file. An uncaught exception may have occurred within the JSX script.',
    );
  }
  if (result.error) {
    const parts: string[] = [];
    if (result.message) parts.push(result.message as string);
    if (result.line != null) parts.push(`(JSX line ${result.line})`);
    throw new Error(parts.length > 0 ? parts.join(' ') : 'An unknown error occurred during JSX execution');
  }
  return result;
}

// ─── 公開 API ────────────────────────────────────────────────────────────────

/**
 * JSX を実行する（排他制御なし — 内部用）
 */
async function executeJsxRaw(
  jsxCode: string,
  params?: unknown,
  timeout: number = TIMEOUT_NORMAL,
  activate: boolean = false,
): Promise<JsxResult> {
  const transport = getTransport();
  return executeViaTransport(transport, jsxCode, params, timeout, activate);
}

/**
 * JSX を実行する（排他制御付き — 公開 API）
 * pendingCount は jsxLimit の外側で管理し、キュー待ちのタスクも追跡する
 */
export async function executeJsx(
  jsxCode: string,
  params?: unknown,
  options?: { timeout?: number; activate?: boolean },
): Promise<JsxResult> {
  pendingCount++;
  try {
    return await jsxLimit(() => executeJsxRaw(
      jsxCode,
      params,
      options?.timeout ?? TIMEOUT_NORMAL,
      options?.activate ?? false,
    ));
  } finally {
    pendingCount--;
    if (pendingCount === 0 && pendingResolvers.length > 0) {
      pendingResolvers.splice(0).forEach((r) => r());
    }
  }
}

/**
 * 重い処理用の JSX 実行（タイムアウト延長 + Illustrator をフォアグラウンドに）
 */
export async function executeJsxHeavy(
  jsxCode: string,
  params?: unknown,
): Promise<JsxResult> {
  return executeJsx(jsxCode, params, { timeout: TIMEOUT_HEAVY, activate: true });
}

// ─── デバッグ用エクスポート ──────────────────────────────────────────────────
export { getTransport as TRANSPORT };
