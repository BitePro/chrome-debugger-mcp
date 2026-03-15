import CDP, {
    CDPClient,
    CallFrame,
    RuntimeRemoteObject,
    PropertyDescriptor,
    ChromeTarget,
  } from "chrome-remote-interface";
  import { spawn } from "child_process";
  import * as http from "http";
  import * as os from "os";
  import * as path from "path";
  
  const MAX_PROPERTY_DEPTH = 3;
  const SKIP_SCOPE_TYPES = new Set(["global"]);
  const RELOAD_STATE_TIMEOUT_MS = 15_000;
  const STEP_TIMEOUT_MS = 30_000;
  
  function quotePosixArg(arg: string): string {
    if (arg.length === 0) {
      return "''";
    }
  
    return `'${arg.replace(/'/g, `'\\''`)}'`;
  }
  
  function quoteWindowsArg(arg: string): string {
    if (!/[\s"]/u.test(arg)) {
      return arg;
    }
  
    let escaped = '"';
    let backslashCount = 0;
  
    for (const char of arg) {
      if (char === "\\") {
        backslashCount += 1;
        continue;
      }
  
      if (char === '"') {
        escaped += "\\".repeat(backslashCount * 2 + 1);
        escaped += '"';
        backslashCount = 0;
        continue;
      }
  
      escaped += "\\".repeat(backslashCount);
      escaped += char;
      backslashCount = 0;
    }
  
    escaped += "\\".repeat(backslashCount * 2);
    escaped += '"';
  
    return escaped;
  }
  
  function quoteShellArg(arg: string): string {
    return process.platform === "win32"
      ? quoteWindowsArg(arg)
      : quotePosixArg(arg);
  }
  
  export interface PauseInfo {
    reason: string;
    callFrames: CallFrame[];
    hitBreakpoints?: string[];
  }
  
  export interface VariableInfo {
    name: string;
    value: string;
    type: string;
    subtype?: string;
    structuredValue?: unknown;
  }
  
  export interface ScopeGroup {
    type: string;
    name?: string;
    variables: VariableInfo[];
  }
  
  export interface DebuggerStatus {
    connected: boolean;
    paused: boolean;
    pauseReason?: string;
    hitBreakpoints?: string[];
    callStack?: Array<{
      index: number;
      functionName: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    }>;
  }
  
  export type PauseListener = (info: PauseInfo) => void;
  
  interface PauseWaiter {
    resolve: (info: PauseInfo) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
  
  interface PauseWaitHandle {
    promise: Promise<PauseInfo>;
    cancel: (error: Error) => void;
  }
  export class ChromeDebuggerManager {
    private client: CDPClient | null = null;
    private pauseInfo: PauseInfo | null = null;
    private pauseWaiters: PauseWaiter[] = [];
    private pauseListeners: PauseListener[] = [];
    private connected = false;
    private connectedTargetUrl: string = "";
    /** Whether a reloadPage() is in progress – avoids treating that load as "resumed" unexpectedly */
    private reloading = false;
    private reloadResetTimer: ReturnType<typeof setTimeout> | null = null;
  
    get isConnected(): boolean {
      return this.connected;
    }
  
    get isPaused(): boolean {
      return this.pauseInfo !== null;
    }
  
    get currentPauseInfo(): PauseInfo | null {
      return this.pauseInfo;
    }
  
    onPause(listener: PauseListener): void {
      this.pauseListeners.push(listener);
    }
  
    // ─── Chrome launch helpers ──────────────────────────────
  
    /** Probe whether Chrome's CDP HTTP endpoint is responding on the given port. */
    async isDebugPortAlive(port: number = 9222): Promise<boolean> {
      return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(1500, () => {
          req.destroy();
          resolve(false);
        });
      });
    }
  
    /** Return the Chrome executable path for the current OS. */
    getChromePath(explicitPath?: string): string {
      if (explicitPath?.trim()) {
        return explicitPath.trim();
      }
  
      const envChromePath = process.env.CHROME_PATH
        ?? process.env.CHROME_EXECUTABLE
        ?? process.env.GOOGLE_CHROME_BIN;
      if (envChromePath?.trim()) {
        return envChromePath.trim();
      }
  
      switch (process.platform) {
        case "darwin":
          return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
        case "linux":
          return "google-chrome";
        case "win32":
          return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
        default:
          throw new Error(`Unsupported platform: ${process.platform}`);
      }
    }
  
    /**
     * Launch Chrome with remote debugging enabled (dual-instance via --user-data-dir).
     * If Chrome is already listening on the port, skips launch.
     * dryRun=true only returns the command without executing.
     * openDevTools=true adds --auto-open-devtools-for-tabs so DevTools opens automatically.
     */
    async launchChrome(
      options: {
        port?: number;
        userDataDir?: string;
        dryRun?: boolean;
        url?: string;
        openDevTools?: boolean;
        chromePath?: string;
      } = {},
    ): Promise<{
      command: string;
      alreadyRunning: boolean;
      launched: boolean;
      message: string;
      requiresManualLaunch?: boolean;
    }> {
      const port = options.port ?? 9222;
      const userDataDir =
        options.userDataDir ?? path.join(os.homedir(), ".chrome-debug-profile");
      const chromePath = this.getChromePath(options.chromePath);
  
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
      ];
      // 自动为每个新标签页打开 DevTools 控制台
      if (options.openDevTools) args.push("--auto-open-devtools-for-tabs");
      if (options.url) args.push(options.url);
  
      const command = [chromePath, ...args].map(quoteShellArg).join(" ");
  
      // Already running?
      const alreadyRunning = await this.isDebugPortAlive(port);
      if (alreadyRunning) {
        return {
          command,
          alreadyRunning: true,
          launched: false,
          message: `Chrome debug port ${port} is already active. No new instance started.`,
        };
      }
  
      if (options.dryRun) {
        return {
          command,
          alreadyRunning: false,
          launched: false,
          message:
            "Dry run – Chrome was NOT launched. Confirm and re-run without dryRun to execute.",
        };
      }
  
      try {
        const proc = spawn(chromePath, args, { detached: true, stdio: "ignore" });
        proc.unref();
  
        // Give Chrome ~2 s to bind the port
        await new Promise((r) => setTimeout(r, 2000));
        const alive = await this.isDebugPortAlive(port);
  
        return {
          command,
          alreadyRunning: false,
          launched: alive,
          message: alive
            ? `Chrome launched. Debug port: ${port}. Profile dir: ${userDataDir}`
            : `Chrome did not expose debug port ${port} within 2 seconds. Run the command manually if Chrome did not open.`,
          requiresManualLaunch: !alive,
        };
      } catch (e: any) {
        return {
          command,
          alreadyRunning: false,
          launched: false,
          message: `Automatic launch failed: ${e.message}`,
          requiresManualLaunch: true,
        };
      }
    }
  
    /** List all available Chrome tabs/targets on the given port. */
    async listTargets(port: number = 9222): Promise<ChromeTarget[]> {
      return CDP.List({ port });
    }
  
    /**
     * Connect to Chrome.
     * @param port   Remote debugging port (default 9222).
     * @param targetUrlFilter  A substring of the tab URL/title to connect to (e.g. "localhost:8080").
     *                         Required when multiple page tabs are available.
     */
    async connect(
      port: number = 9222,
      targetUrlFilter?: string,
    ): Promise<string> {
      if (this.client) {
        await this.disconnect();
      }
  
      const targets = await CDP.List({ port });
      if (targets.length === 0) {
        throw new Error(
          `No Chrome targets found on port ${port}. Is Chrome running with --remote-debugging-port=${port}?`,
        );
      }
  
      const pageTargets = targets.filter(
        (t) =>
          t.type === "page" &&
          !t.url.startsWith("devtools://") &&
          !t.url.startsWith("chrome-extension://"),
      );
  
      if (pageTargets.length === 0) {
        throw new Error(
          `No page targets found on port ${port}. Open your target page first.`,
        );
      }
  
      let target: ChromeTarget | undefined;
      const filter = targetUrlFilter?.trim();
  
      // targetUrl 必须由用户明确确认后再传入，单 tab 也不例外
      if (!filter) {
        const urls = pageTargets.map((t, i) => `  [${i}] ${t.url}`).join("\n");
        throw new Error(
          `targetUrl is required. Call listTargets first, show the list to the user, wait for their confirmation, then pass the confirmed URL substring.\nAvailable page targets:\n${urls}`,
        );
      }
  
      const matches = pageTargets.filter(
        (t) => t.url.includes(filter) || (t.title ?? "").includes(filter),
      );
      if (matches.length === 0) {
        const urls = pageTargets.map((t) => `  [${t.type}] ${t.url}`).join("\n");
        throw new Error(
          `No page target matching "${filter}" found.\nAvailable page targets:\n${urls}`,
        );
      }
      if (matches.length > 1) {
        const urls = matches.map((t) => `  [${t.type}] ${t.url}`).join("\n");
        throw new Error(
          `targetUrl "${filter}" matches multiple pages. Use a more specific substring.\nMatched targets:\n${urls}`,
        );
      }
      target = matches[0];
  
      this.client = await CDP({ port, target: target.id });
      this.connected = true;
      this.connectedTargetUrl = target.url;
  
      await this.client.Page.enable();
      await this.client.Debugger.enable();
      await this.client.Runtime.enable();
  
      this.client.Debugger.paused((params) => {
        this.pauseInfo = {
          reason: params.reason,
          callFrames: params.callFrames,
          hitBreakpoints: params.hitBreakpoints,
        };
        this.finishReloadCycle();
  
        const waiters = this.pauseWaiters.splice(0);
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.resolve(this.pauseInfo);
        }
  
        for (const listener of this.pauseListeners) {
          try {
            listener(this.pauseInfo);
          } catch {
            // ignore listener errors
          }
        }
      });
  
      this.client.Debugger.resumed(() => {
        this.pauseInfo = null;
      });
  
      this.client.Page.loadEventFired(() => {
        this.finishReloadCycle();
      });
  
      this.client.on("disconnect", () => {
        this.resetConnectionState(
          new Error("Chrome debugging session disconnected."),
        );
      });
      this.client.on("Inspector.detached", () => {
        this.resetConnectionState(
          new Error("Chrome debugging session detached from the target."),
        );
      });
  
      // Re-enable Debugger domain after page navigation so pending breakpoints survive
      this.client.on("Runtime.executionContextsCleared", async () => {
        if (this.reloading) return;
        try {
          await this.client!.Debugger.enable();
          await this.client!.Runtime.enable();
        } catch {
          // target may have gone away
        }
      });
  
      return `Connected to: ${target.title || target.url} (${target.url})`;
    }
  
    async disconnect(): Promise<void> {
      if (this.client) {
        const client = this.client;
        try {
          await client.Debugger.disable();
        } catch {
          // ignore
        }
        try {
          await client.close();
        } catch {
          // ignore
        }
        this.resetConnectionState(new Error("Disconnected from Chrome."));
      }
    }
    /** Reload the page via CDP (more reliable than manual browser refresh). */
  async reloadPage(ignoreCache: boolean = false): Promise<string> {
    this.ensureConnected();
    this.beginReloadCycle();
    try {
      await this.client!.Page.reload({ ignoreCache });
      return "Page reload requested";
    } catch (error) {
      this.finishReloadCycle();
      throw error;
    }
  }

  async setBreakpoint(
    url: string,
    lineNumber: number,
    columnNumber?: number,
    condition?: string,
  ): Promise<{
    breakpointId: string;
    locations: any[];
    pending: boolean;
    hint?: string;
  }> {
    this.ensureConnected();

    // Full URL (with protocol) → exact match; partial name/keyword → urlRegex
    const isFullUrl = /^(https?|file|chrome):\/\//i.test(url);
    const params = isFullUrl
      ? { lineNumber, url, columnNumber, condition }
      : {
          lineNumber,
          urlRegex: url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          columnNumber,
          condition,
        };

    const result = await this.client!.Debugger.setBreakpointByUrl(params);
    const pending = result.locations.length === 0;
    return {
      breakpointId: result.breakpointId,
      locations: result.locations,
      pending,
      ...(pending && {
        hint: "Pending breakpoint – call reloadPage() to reload via CDP, which guarantees the breakpoint resolves when the script loads.",
      }),
    };
  }

  async removeBreakpoint(breakpointId: string): Promise<void> {
    this.ensureConnected();
    await this.client!.Debugger.removeBreakpoint({ breakpointId });
  }

  /** Non-blocking status check – returns immediately with current state. */
  getStatus(): DebuggerStatus & { targetUrl?: string } {
    if (!this.connected) {
      return { connected: false, paused: false };
    }
    if (!this.pauseInfo) {
      return {
        connected: true,
        paused: false,
        targetUrl: this.connectedTargetUrl,
      };
    }
    return {
      connected: true,
      paused: true,
      targetUrl: this.connectedTargetUrl,
      pauseReason: this.pauseInfo.reason,
      hitBreakpoints: this.pauseInfo.hitBreakpoints,
      callStack: this.getCallStackSummary(),
    };
  }

  /**
   * Wait up to `timeoutMs` for the debugger to pause.
   *
   * NOTE: MCP Inspector has a built-in request timeout (default ~10 s).
   * If you see a -32001 timeout from Inspector, either:
   *   1. Increase Inspector timeout in its UI to ≥ 60000
   *   2. Use a shorter timeout here and retry with polling via getStatus()
   */
  async waitForPause(timeoutMs: number = 30000): Promise<PauseInfo> {
    this.ensureConnected();
    if (this.pauseInfo) {
      return this.pauseInfo;
    }

    return this.createPauseWait(
      timeoutMs,
      `Timeout: debugger did not pause within ${timeoutMs}ms. Try calling getStatus() to poll, or increase the timeout.`,
    ).promise;
  }

  /**
   * Wait for the NEXT debugger pause, then check whether it matches the target location.
   *
   * ⚠️ No auto-resume: execution stays paused after this returns, regardless of whether
   * the pause matched. The caller (AI) decides what to do next:
   *   - matched=true  → call getScopeVariables() / evaluate() to read variables
   *   - matched=false → call resume() explicitly, then waitForSpecificPause() again if needed
   *
   * Matching uses two tiers:
   *   Tier 1 (exact):    URL contains urlFragment AND |compiledLine - expectedLine| <= lineTolerance
   *   Tier 2 (semantic): URL contains urlFragment AND reason === "debugger-statement"
   *     CDP reports compiled line numbers; for transpiled/bundled code the line may differ
   *     from source, but reason="debugger-statement" is a reliable signal that it IS the
   *     debugger; statement we inserted.
   *
   * @param urlFragment   Substring of the script URL where debugger; was added
   * @param expectedLine  0-based line number (editor line N → pass N-1)
   * @param timeoutMs     How long to wait for any pause (default 90 s)
   * @param lineTolerance ±line tolerance for Tier 1 (default 10)
   */
  async waitForSpecificPause(
    urlFragment: string,
    expectedLine: number,
    timeoutMs: number = 90000,
    lineTolerance: number = 10,
  ): Promise<{
    matched: boolean;
    reason: string;
    pausedUrl: string;
    pausedLine: number;
    functionName: string;
    callStack: ReturnType<ChromeDebuggerManager["getCallStackSummary"]>;
    lineMatchedByTolerance: boolean;
    note: string;
  }> {
    this.ensureConnected();

    // 等待下一次暂停（不自动 resume，不循环）
    const info = await this.waitForPause(timeoutMs);
    const top = info.callFrames[0];

    // 第1层：URL + 行号容差匹配
    const exactFrame = info.callFrames.find(
      (f) =>
        f.url.includes(urlFragment) &&
        Math.abs(f.location.lineNumber - expectedLine) <= lineTolerance,
    );

    // 第2层：URL + reason 语义匹配（debugger; 触发时 reason 必为 "debugger-statement"）
    const semanticFrame =
      !exactFrame && info.reason === "debugger-statement"
        ? info.callFrames.find((f) => f.url.includes(urlFragment))
        : undefined;

    const matchedFrame = exactFrame ?? semanticFrame;
    const matched = !!matchedFrame;

    // 构建返回值，matched=false 时提示 AI 下一步操作
    let note: string;
    if (matched && exactFrame) {
      note = `Matched at "${matchedFrame!.url}" line ${matchedFrame!.location.lineNumber}. Call getScopeVariables() to read variables.`;
    } else if (matched && semanticFrame) {
      note = `Matched by debugger-statement reason at "${matchedFrame!.url}" line ${matchedFrame!.location.lineNumber} (compiled). Source line was ${expectedLine}; offset is normal for transpiled code. Call getScopeVariables() to read variables.`;
    } else {
      note = `Paused at "${top?.url ?? ""}" line ${top?.location.lineNumber ?? -1} (reason: ${info.reason}), which does NOT match urlFragment="${urlFragment}" near line ${expectedLine}. Execution is still paused. Options: (1) call getScopeVariables() to inspect here anyway, (2) call resume() to continue, then waitForSpecificPause() again to wait for the next pause.`;
    }

    return {
      matched,
      reason: info.reason,
      pausedUrl: matchedFrame?.url ?? top?.url ?? "",
      pausedLine: matchedFrame?.location.lineNumber ?? top?.location.lineNumber ?? -1,
      functionName: (matchedFrame ?? top)?.functionName || "(anonymous)",
      callStack: this.getCallStackSummary(),
      lineMatchedByTolerance: !!exactFrame,
      note,
    };
  }

  async getScopeVariables(frameIndex: number = 0): Promise<ScopeGroup[]> {
    this.ensurePaused();
    const frames = this.pauseInfo!.callFrames;
    if (frameIndex < 0 || frameIndex >= frames.length) {
      throw new Error(
        `Frame index ${frameIndex} out of range (0-${frames.length - 1})`,
      );
    }
    const frame = frames[frameIndex];
    const scopeGroups: ScopeGroup[] = [];

    for (const scope of frame.scopeChain) {
      if (SKIP_SCOPE_TYPES.has(scope.type)) continue;
      if (!scope.object.objectId) continue;

      const variables = await this.getObjectProperties(
        scope.object.objectId,
        0,
      );
      scopeGroups.push({
        type: scope.type,
        name: scope.name,
        variables,
      });
    }

    return scopeGroups;
  }

  async evaluate(
    expression: string,
    frameIndex: number = 0,
  ): Promise<{ result: any; exceptionDetails?: any }> {
    this.ensurePaused();
    const frames = this.pauseInfo!.callFrames;
    if (frameIndex < 0 || frameIndex >= frames.length) {
      throw new Error(
        `Frame index ${frameIndex} out of range (0-${frames.length - 1})`,
      );
    }
    const frame = frames[frameIndex];
    const response = await this.client!.Debugger.evaluateOnCallFrame({
      callFrameId: frame.callFrameId,
      expression,
      generatePreview: true,
      returnByValue: false,
    });

    return {
      result: this.formatRemoteObject(response.result),
      exceptionDetails: response.exceptionDetails
        ? {
            text: response.exceptionDetails.text,
            line: response.exceptionDetails.lineNumber,
            column: response.exceptionDetails.columnNumber,
            exception: response.exceptionDetails.exception
              ? this.formatRemoteObject(response.exceptionDetails.exception)
              : undefined,
          }
        : undefined,
    };
  }

  async resume(): Promise<void> {
    this.ensurePaused();
    await this.client!.Debugger.resume();
  }

  async stepInto(timeoutMs: number = STEP_TIMEOUT_MS): Promise<PauseInfo> {
    this.ensurePaused();
    return this.stepAndWait(
      () => this.client!.Debugger.stepInto(),
      "step into",
      timeoutMs,
    );
  }

  async stepOver(timeoutMs: number = STEP_TIMEOUT_MS): Promise<PauseInfo> {
    this.ensurePaused();
    return this.stepAndWait(
      () => this.client!.Debugger.stepOver(),
      "step over",
      timeoutMs,
    );
  }

  async stepOut(timeoutMs: number = STEP_TIMEOUT_MS): Promise<PauseInfo> {
    this.ensurePaused();
    return this.stepAndWait(
      () => this.client!.Debugger.stepOut(),
      "step out",
      timeoutMs,
    );
  }

  async pause(): Promise<void> {
    this.ensureConnected();
    await this.client!.Debugger.pause();
  }

  getCallStackSummary(): Array<{
    index: number;
    functionName: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  }> {
    if (!this.pauseInfo) return [];
    return this.pauseInfo.callFrames.map((frame, index) => ({
      index,
      functionName: frame.functionName || "(anonymous)",
      url: frame.url,
      lineNumber: frame.location.lineNumber,
      columnNumber: frame.location.columnNumber,
    }));
  }

  // ─── internal helpers ──────────────────────────────────────

  private async getObjectProperties(
    objectId: string,
    depth: number,
  ): Promise<VariableInfo[]> {
    if (depth >= MAX_PROPERTY_DEPTH) {
      return [{ name: "...", value: "(max depth reached)", type: "info" }];
    }
    const { result: properties } = await this.client!.Runtime.getProperties({
      objectId,
      ownProperties: true,
      generatePreview: true,
    });

    const variables: VariableInfo[] = [];
    for (const prop of properties) {
      if (!prop.value) continue;
      variables.push(await this.formatProperty(prop, depth));
    }
    return variables;
  }

  private async formatProperty(
    prop: PropertyDescriptor,
    depth: number,
  ): Promise<VariableInfo> {
    const obj = prop.value!;
    const info: VariableInfo = {
      name: prop.name,
      type: obj.type,
      value: this.primitiveValue(obj),
    };
    if (obj.subtype) info.subtype = obj.subtype;
    info.structuredValue = await this.toStructuredValue(obj, depth);

    if (
      obj.type === "object" &&
      obj.objectId &&
      obj.subtype !== "null" &&
      depth < MAX_PROPERTY_DEPTH - 1
    ) {
      info.value = this.describeStructuredValue(
        obj,
        info.structuredValue,
      );
    }
    return info;
  }

  private primitiveValue(obj: RuntimeRemoteObject): string {
    if (obj.type === "undefined") return "undefined";
    if (obj.subtype === "null") return "null";
    if (obj.type === "string") return JSON.stringify(obj.value);
    if (
      obj.type === "number" ||
      obj.type === "boolean" ||
      obj.type === "bigint"
    ) {
      return String(obj.unserializableValue ?? obj.value);
    }
    if (obj.type === "symbol") return obj.description ?? "Symbol()";
    if (obj.type === "function") return obj.description ?? "function(){}";
    return obj.description ?? obj.className ?? `[${obj.type}]`;
  }

  private formatRemoteObject(obj: RuntimeRemoteObject): any {
    if (
      obj.type === "undefined" ||
      obj.type === "string" ||
      obj.type === "number" ||
      obj.type === "boolean"
    ) {
      return { type: obj.type, value: obj.value };
    }
    if (obj.subtype === "null") {
      return { type: "object", subtype: "null", value: null };
    }
    return {
      type: obj.type,
      subtype: obj.subtype,
      className: obj.className,
      description: obj.description,
      preview: obj.preview
        ? obj.preview.properties.map((p) => ({
            name: p.name,
            type: p.type,
            value: p.value,
          }))
        : undefined,
    };
  }
  private async toStructuredValue(
    obj: RuntimeRemoteObject,
    depth: number,
  ): Promise<unknown> {
    if (obj.type === "undefined") return "undefined";
    if (obj.subtype === "null") return null;
    if (obj.type === "string") return obj.value ?? "";
    if (obj.type === "number") {
      return obj.unserializableValue ?? obj.value ?? "NaN";
    }
    if (obj.type === "boolean") return obj.value ?? false;
    if (obj.type === "bigint") {
      return obj.unserializableValue ?? String(obj.value ?? "");
    }
    if (obj.type === "symbol") return obj.description ?? "Symbol()";
    if (obj.type === "function") return obj.description ?? "function(){}";

    if (!obj.objectId || depth >= MAX_PROPERTY_DEPTH - 1) {
      return obj.description ?? obj.className ?? `[${obj.type}]`;
    }

    const children = await this.getObjectProperties(obj.objectId, depth + 1);
    if (obj.subtype === "array") {
      return this.childrenToArray(children);
    }

    return Object.fromEntries(
      children.map((child) => [
        child.name,
        child.structuredValue ?? child.value,
      ]),
    );
  }

  private childrenToArray(children: VariableInfo[]): unknown[] {
    const numericEntries = children
      .filter((child) => /^\d+$/u.test(child.name))
      .map((child) => [
        Number(child.name),
        child.structuredValue ?? child.value,
      ] as const)
      .sort((left, right) => left[0] - right[0]);

    const result: unknown[] = [];
    for (const [index, value] of numericEntries) {
      result[index] = value;
    }
    return result;
  }

  private describeStructuredValue(
    obj: RuntimeRemoteObject,
    structuredValue: unknown,
  ): string {
    if (obj.subtype === "array" && Array.isArray(structuredValue)) {
      return `Array(${structuredValue.length})`;
    }

    if (
      structuredValue &&
      typeof structuredValue === "object" &&
      !Array.isArray(structuredValue)
    ) {
      const size = Object.keys(structuredValue).length;
      const label = obj.className ?? obj.description ?? "Object";
      return `${label}(${size})`;
    }

    return obj.description ?? obj.className ?? `[${obj.type}]`;
  }

  private beginReloadCycle(): void {
    this.reloading = true;
    this.pauseInfo = null;
    if (this.reloadResetTimer) {
      clearTimeout(this.reloadResetTimer);
    }
    this.reloadResetTimer = setTimeout(() => {
      this.finishReloadCycle();
    }, RELOAD_STATE_TIMEOUT_MS);
  }

  private finishReloadCycle(): void {
    this.reloading = false;
    if (this.reloadResetTimer) {
      clearTimeout(this.reloadResetTimer);
      this.reloadResetTimer = null;
    }
  }

  private createPauseWait(
    timeoutMs: number,
    timeoutMessage: string,
  ): PauseWaitHandle {
    let waiter!: PauseWaiter;

    const promise = new Promise<PauseInfo>((resolve, reject) => {
      waiter = {
        resolve: (info) => {
          this.removePauseWaiter(waiter);
          resolve(info);
        },
        reject: (error) => {
          this.removePauseWaiter(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          waiter.reject(new Error(timeoutMessage));
        }, timeoutMs),
      };

      this.pauseWaiters.push(waiter);
    });

    return {
      promise,
      cancel: (error) => {
        waiter.reject(error);
      },
    };
  }

  private async stepAndWait(
    command: () => Promise<void>,
    label: string,
    timeoutMs: number,
  ): Promise<PauseInfo> {
    const nextPauseWait = this.createPauseWait(
      timeoutMs,
      `Timeout: debugger did not pause again after ${label} within ${timeoutMs}ms.`,
    );

    try {
      await command();
      return await nextPauseWait.promise;
    } catch (error: any) {
      nextPauseWait.cancel(
        error instanceof Error
          ? error
          : new Error(`Failed to ${label}.`),
      );
      throw error;
    }
  }

  private removePauseWaiter(waiter: PauseWaiter): void {
    clearTimeout(waiter.timer);
    const index = this.pauseWaiters.indexOf(waiter);
    if (index !== -1) {
      this.pauseWaiters.splice(index, 1);
    }
  }

  private rejectPauseWaiters(error: Error): void {
    const waiters = this.pauseWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private resetConnectionState(waiterError: Error): void {
    this.client = null;
    this.connected = false;
    this.connectedTargetUrl = "";
    this.pauseInfo = null;
    this.finishReloadCycle();
    this.rejectPauseWaiters(waiterError);
  }

  private ensureConnected(): void {
    if (!this.client || !this.connected) {
      throw new Error("Not connected to Chrome. Call connect() first.");
    }
  }

  private ensurePaused(): void {
    this.ensureConnected();
    if (!this.pauseInfo) {
      throw new Error(
        "Debugger is not paused. Use waitForPause() or set a breakpoint first.",
      );
    }
  }
}