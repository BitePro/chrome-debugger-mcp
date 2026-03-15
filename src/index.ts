#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ChromeDebuggerManager } from "./chrome-manager.js";

const manager = new ChromeDebuggerManager();

const server = new McpServer({
  name: "chrome-debugger-mcp",
  version: "1.0.0",
}, {
  capabilities: {
    logging: {},
  },
});

const USER_ACTION_REMINDER_DELAY_MS = 15_000;
const DEFAULT_SPECIFIC_PAUSE_TIMEOUT_MS = 90_000;

manager.onPause((info) => {
  void server.server.sendLoggingMessage({
    level: "info",
    data: JSON.stringify({
      event: "debugger/paused",
      reason: info.reason,
      hitBreakpoints: info.hitBreakpoints,
      callStack: info.callFrames.map((f, i) => ({
        index: i,
        functionName: f.functionName || "(anonymous)",
        url: f.url,
        line: f.location.lineNumber,
        column: f.location.columnNumber,
      })),
    }),
  }).catch(() => {});
});

// 统一成功返回格式
function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

// 统一错误返回格式
function fail(message: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }) },
    ],
    isError: true,
  };
}

function buildUserActionMessage(
  heading: string,
  actionHint: string | undefined,
  timeoutMs: number,
  targetDescription?: string,
) {
  const actionText = actionHint?.trim()
    ? actionHint.trim()
    : "Perform the page action that should trigger the breakpoint.";
  const lines = [
    heading,
    "Use the connected Chrome page now.",
  ];

  if (targetDescription) {
    lines.push(`Target: ${targetDescription}`);
  }

  lines.push(
    "Required action:",
    actionText,
    `Waiting timeout: ${timeoutMs}ms`,
  );

  return lines.join("\n");
}

async function sendUserActionPrompt(
  heading: string,
  actionHint: string | undefined,
  timeoutMs: number,
  targetDescription?: string,
) {
  await server.server.sendLoggingMessage({
    level: "warning",
    data: buildUserActionMessage(
      heading,
      actionHint,
      timeoutMs,
      targetDescription,
    ),
  });
}

function scheduleUserActionReminder(
  actionHint: string | undefined,
  timeoutMs: number,
  targetDescription?: string,
) {
  const reminderDelayMs = Math.min(
    USER_ACTION_REMINDER_DELAY_MS,
    Math.max(5_000, Math.floor(timeoutMs / 2)),
  );
  const timer = setTimeout(() => {
    void server.server.sendLoggingMessage({
      level: "warning",
      data: buildUserActionMessage(
        "ACTION STILL REQUIRED",
        actionHint,
        timeoutMs,
        targetDescription,
      ),
    }).catch(() => {});
  }, reminderDelayMs);

  return () => clearTimeout(timer);
}

// ── startDebuggingSession ──────────────────────────────────
// 元工具：触发条件描述 + 完整工作流说明，AI 在需要调试时优先调用此工具
server.tool(
  "startDebuggingSession",
  `CALL THIS FIRST whenever browser-side debugging is needed — before any other tool.

Auto-trigger when user mentions any of:
  debug, breakpoint, debugger, inspect, trace, step through, runtime value,
  variable value, why is this, implement based on API response, bug, error,
  unexpected behavior, not working, check this, confirm this.

Returns the complete debugging workflow and critical rules.
The response contains a "_ui" field — relay it to the user verbatim.`,
  {},
  () => {
    return ok({
      // AI 必须将 _ui 展示给用户
      _ui: {
        status: "Starting debug session",
        message: "I'm starting a Chrome debugging session. I'll guide you through each step.",
      },
      title: "Chrome DevTools Debugging Workflow",
      // 关键规则，AI 必须严格遵守
      critical_rules: [
        "ALWAYS relay the '_ui' field from every tool response to the user immediately.",
        "NEVER skip listTargets. NEVER guess the target URL. ALWAYS wait for user confirmation before connect().",
        "Even if there is only one tab open, you MUST show it to the user and wait for confirmation.",
        "Use waitForSpecificPause (not waitForPause) after inserting debugger; — it uses two-tier matching: line tolerance + debugger-statement reason.",
        "Conclusions MUST cite actual values from getScopeVariables/evaluate. No guessing from static code.",
        "Always call resume() and remove temporary debugger; statements at the end.",
      ],
      // 轮次边界规则：明确哪些步骤之间允许结束对话轮次，哪些必须连续执行
      turn_boundary_rules: [
        "ALLOWED turn-end points (steps where user input is truly required):",
        "  • After launchChrome(dryRun=true): end turn, show command, wait for user confirmation.",
        "  • After listTargets: end turn, show tab list, wait for user to pick a URL.",
        "  • That's it — those are the ONLY two points where you may end your turn.",
        "FORBIDDEN turn-end points (NEVER end your turn here):",
        "  • After launchChrome() (non-dryRun): immediately call listTargets in the same turn.",
        "  • After connect(): immediately add debugger; to source and call reloadPage in the same turn.",
        "  • After reloadPage(): IMMEDIATELY call waitForSpecificPause in the SAME turn — do NOT end your turn here. waitForSpecificPause is a blocking call; it will notify the user to trigger the action and wait for the breakpoint internally.",
        "  • After waitForSpecificPause returns: immediately call getScopeVariables in the same turn.",
        "  • After getScopeVariables: immediately call evaluate/resume as needed in the same turn.",
        "KEY RULE: reloadPage → waitForSpecificPause MUST be two consecutive tool calls in the same AI turn. If you end your turn between them, the session breaks.",
      ],
      steps: [
        {
          step: 1,
          tool: "launchChrome",
          action: "launchChrome({ dryRun: true }) → [END TURN] show command to user → wait for confirmation → launchChrome()",
          note: "If alreadyRunning=true, skip to step 2 in the same turn. Add openDevTools=true to auto-open DevTools panel.",
        },
        {
          step: 2,
          tool: "listTargets",
          action: "listTargets() → [END TURN] show the full tab list to the user → wait for URL reply",
          note: "MANDATORY: show all tabs, ask which URL to debug, wait for reply — even if only one tab.",
        },
        {
          step: 3,
          tool: "connect",
          action: "connect({ targetUrl }) → [SAME TURN] add debugger; to source → reloadPage() → waitForSpecificPause()",
          note: "Do NOT end your turn after connect. Continue immediately to steps 4 and 5 in the same turn.",
        },
        {
          step: 4,
          tool: "(edit source)",
          action: "[SAME TURN as step 3] Add `debugger; // TODO: remove debugger` at the observation point",
          note: "Record exact filename and editor line number — needed for step 5.",
        },
        {
          step: 5,
          tool: "reloadPage + waitForSpecificPause",
          action: "[SAME TURN] reloadPage() → immediately waitForSpecificPause({ urlFragment, line: editorLine - 1, timeout: 90000, actionHint: 'describe the action' })",
          note: "waitForSpecificPause is BLOCKING with NO auto-resume. Check 'matched' in response: matched=true → go to step 6; matched=false → call resume() then waitForSpecificPause() again.",
        },
        {
          step: 6,
          tool: "getScopeVariables + evaluate",
          action: "[SAME TURN as step 5, only if matched=true] getScopeVariables({ frameIndex: 0 }) then evaluate({ expression }) for deep inspection",
          note: "Use frameIndex=1,2... to inspect parent call frames.",
        },
        {
          step: 7,
          tool: "stepOver / stepInto / stepOut",
          action: "[SAME TURN] Step as needed → getScopeVariables() to observe changes",
          note: "Optional — only when tracing variable changes across statements.",
        },
        {
          step: 8,
          tool: "resume",
          action: "[SAME TURN] resume() → remove all temporary debugger; lines from source code",
          note: "Session complete. Use the real collected values to implement or fix code.",
        },
      ],
    });
  },
);

// ── launchChrome ───────────────────────────────────────────
// 步骤1：启动调试专用 Chrome 实例（双实例，独立 profile）
server.tool(
  "launchChrome",
  `[STEP 1] Launch a dedicated Chrome instance with remote debugging enabled (default port 9222).
Uses --user-data-dir=~/.chrome-debug-profile so your normal Chrome keeps running (dual-instance).
Auto-detects if the debug port is already active and skips launch (alreadyRunning=true).
Use dryRun=true to preview the command — show it to the user and ask for confirmation before executing.
Set openDevTools=true to automatically open DevTools panel for every new tab.
If automatic launch does not succeed, relay the returned command to the user and ask them to run it manually.
Relay the "_ui" field from the response to the user.`,
  {
    port: z.number().int().positive().optional()
      .describe("Remote debugging port (default 9222)"),
    userDataDir: z.string().optional()
      .describe("Profile directory for the debug instance (default ~/.chrome-debug-profile)"),
    chromePath: z.string().optional()
      .describe("Chrome executable path. Overrides platform defaults and CHROME_PATH/GOOGLE_CHROME_BIN."),
    dryRun: z.boolean().optional()
      .describe("If true, return the launch command without executing it"),
    url: z.string().optional()
      .describe("URL to open immediately after launch"),
    // 自动为新标签页打开 DevTools 控制台
    openDevTools: z.boolean().optional()
      .describe("If true, adds --auto-open-devtools-for-tabs so DevTools opens automatically for every new tab"),
  },
  async ({ port, userDataDir, chromePath, dryRun, url, openDevTools }) => {
    try {
      const result = await manager.launchChrome({
        port,
        userDataDir,
        chromePath,
        dryRun,
        url,
        openDevTools,
      });

      // 根据返回状态生成用户提示
      let userMessage: string;
      if (result.alreadyRunning) {
        userMessage = `Chrome debug port ${port ?? 9222} is already active — skipping launch. Proceeding to list tabs.`;
      } else if (dryRun) {
        userMessage = `Here is the Chrome launch command. Please confirm and I'll execute it:\n\`\`\`\n${result.command}\n\`\`\``;
      } else if (result.requiresManualLaunch) {
        userMessage = `Chrome did not start successfully. Please launch it manually with this command, then continue:\n\`\`\`\n${result.command}\n\`\`\`\n${result.message}`;
      } else {
        userMessage = result.launched
          ? `Chrome launched successfully with remote debugging on port ${port ?? 9222}.${openDevTools ? " DevTools will open automatically for new tabs." : ""}`
          : `Chrome process started — waiting for it to initialize. I'll list available tabs next.`;
      }

      return ok({ ...result, _ui: { status: "Step 1: Chrome launch", message: userMessage } });
    } catch (e: any) {
      return fail(e.message);
    }
  },
);

// ── listTargets ────────────────────────────────────────────
// 步骤2：列出所有可调试的标签页，必须展示给用户并等待确认
server.tool(
  "listTargets",
  `[STEP 2] List all open Chrome tabs available for debugging.
MANDATORY: show the full list to the user and ask "Which URL do you want to debug?"
NEVER skip this step, NEVER guess — even if only one tab is open.
Wait for the user's explicit reply before proceeding to connect().
Relay the "_ui" field from the response to the user.`,
  {
    port: z.number().int().positive().optional()
      .describe("Chrome remote debugging port (default 9222)"),
  },
  async ({ port }) => {
    try {
      const targets = await manager.listTargets(port ?? 9222);
      const list = targets.map((t, i) => ({
        index: i,
        type: t.type,
        title: t.title,
        url: t.url,
        id: t.id,
      }));

      // 构建展示给用户的标签页列表文本
      const tabLines = list
        .filter((t) => t.type === "page")
        .map((t) => `  [${t.index}] ${t.url}${t.title ? ` — ${t.title}` : ""}`)
        .join("\n");

      return ok({
        targets: list,
        _ui: {
          status: "Step 2: Select debug target",
          message: `Available tabs:\n${tabLines || "  (none)"}\n\nWhich URL do you want to debug? Please confirm the target.`,
          requiresUserReply: true,
        },
      });
    } catch (e: any) {
      return fail(`Failed to list targets: ${e.message}`);
    }
  },
);

// ── connect ────────────────────────────────────────────────
// 步骤3：连接到用户确认的标签页，必须等用户回复 listTargets 后才能调用
server.tool(
  "connect",
  `[STEP 3] Connect the debugger to a specific Chrome tab.
MANDATORY: call listTargets first, show the list to the user, wait for their explicit URL confirmation, then call this.
NEVER guess the URL. NEVER skip user confirmation — even if only one tab is visible.
targetUrl must be a unique substring of the tab URL the user confirmed (e.g. "localhost:5173").
Relay the "_ui" field from the response to the user.`,
  {
    port: z.number().int().positive().optional()
      .describe("Chrome remote debugging port (default 9222)"),
    targetUrl: z.string()
      .describe("Unique substring of the tab URL confirmed by the user (e.g. 'localhost:5173'). REQUIRED — always obtain from user confirmation."),
  },
  async ({ port, targetUrl }) => {
    try {
      const msg = await manager.connect(port ?? 9222, targetUrl);

      return ok({
        message: msg,
        _ui: {
          status: "Step 3: Connected",
          message: `Connected to: ${targetUrl}\n\nNext: I'll insert a temporary \`debugger;\` in the source code at the observation point, then reload the page.`,
        },
      });
    } catch (e: any) {
      return fail(`Failed to connect: ${e.message}`);
    }
  },
);

// ── disconnect ─────────────────────────────────────────────
// 显式断开当前 Chrome 调试连接，释放会话状态
server.tool(
  "disconnect",
  "Disconnect the current Chrome debugging session and clear in-memory pause state. Use this to explicitly end a debug session before connecting again.",
  {},
  async () => {
    try {
      await manager.disconnect();
      return ok({
        message: "Disconnected from Chrome",
        _ui: {
          status: "Disconnected",
          message: "Chrome debugging session disconnected. You can reconnect to another tab when needed.",
        },
      });
    } catch (e: any) {
      return fail(e.message);
    }
  },
);

// ── setBreakpoint ──────────────────────────────────────────
// CDP 断点：无需修改源码，适合无法编辑文件的场景
server.tool(
    "setBreakpoint",
    `Set a breakpoint at a specific script URL and line number via CDP — no source code modification needed.
  Use a full URL (https://...) for exact match, or a partial filename/keyword for regex match.
  Alternative to inserting debugger; when you cannot modify the source file.
  After setting, call reloadPage() to ensure the breakpoint resolves correctly.`,
    {
      url: z.string().describe("Script URL or URL pattern to match"),
      line: z.number().int().nonnegative().describe("0-based line number"),
      column: z.number().int().nonnegative().optional().describe("0-based column number"),
      condition: z.string().optional().describe("Conditional breakpoint expression"),
    },
    async ({ url, line, column, condition }) => {
      try {
        const result = await manager.setBreakpoint(url, line, column, condition);
        return ok(result);
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );
  
  // ── removeBreakpoint ───────────────────────────────────────
  // 移除 setBreakpoint 设置的断点
  server.tool(
    "removeBreakpoint",
    "Remove a previously set CDP breakpoint by its ID (returned by setBreakpoint).",
    {
      breakpointId: z.string().describe("The breakpoint ID returned by setBreakpoint"),
    },
    async ({ breakpointId }) => {
      try {
        await manager.removeBreakpoint(breakpointId);
        return ok({ message: "Breakpoint removed", breakpointId });
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );
  
  // ── waitForPause ───────────────────────────────────────────
  // 备用：阻塞等待任意断点命中，不做位置过滤
  // 阻塞开始前同样通知用户去操作页面
  server.tool(
    "waitForPause",
    `[STEP 5b — FALLBACK] BLOCKING call — waits until ANY debugger pause occurs (breakpoint, debugger; statement, or exception).
  Before blocking, sends a notification to the user to trigger the page action.
  Must be called IMMEDIATELY after reloadPage() in the SAME AI turn — do NOT end your turn before calling this.
  Prefer waitForSpecificPause when you know the exact file and line — it uses smarter two-tier matching.
  Use this only when the target location is unknown or when setBreakpoint is used without a specific line.`,
    {
      timeout: z.number().int().positive().optional()
        .describe("Timeout in milliseconds (default 30000)"),
      // 可选的操作提示
      actionHint: z.string().optional()
        .describe("Optional hint to tell the user what action to perform on the page (e.g. 'click the button', 'submit the form')."),
    },
    async ({ timeout, actionHint }) => {
      const timeoutMs = timeout ?? 30000;
      const clearReminder = scheduleUserActionReminder(actionHint, timeoutMs);
      try {
        await sendUserActionPrompt(
          "ACTION REQUIRED",
          actionHint,
          timeoutMs,
          "any breakpoint",
        );
  
        const info = await manager.waitForPause(timeoutMs);
        return ok({
          reason: info.reason,
          hitBreakpoints: info.hitBreakpoints,
          callStack: manager.getCallStackSummary(),
          _ui: {
            status: "Breakpoint hit",
            message: "Breakpoint triggered! Reading scope variables now...",
          },
        });
      } catch (e: any) {
        return fail(e.message);
      } finally {
        clearReminder();
      }
    },
  );
  
  // ── waitForSpecificPause ────────────────────────────────────
  // 步骤5b（推荐）：阻塞等待下一次暂停，检查是否匹配目标位置，不做任何自动 resume
  // matched=true  → 立刻调用 getScopeVariables 读取变量
  // matched=false → 调用 resume() 继续执行，再次调用 waitForSpecificPause 等待下次暂停
  server.tool(
    "waitForSpecificPause",
    `[STEP 5b — PREFERRED] BLOCKING call — waits for the next debugger pause, then checks if it matches the target location.
  
  ⚠️ NO AUTO-RESUME: execution stays paused after this returns, regardless of matched value.
  You decide what to do based on the "matched" field in the response:
    matched=true  → call getScopeVariables() immediately to read variables
    matched=false → the wrong breakpoint fired; call resume() to continue,
                    then call waitForSpecificPause() again if you need to wait for the next pause.
  
  Must be called IMMEDIATELY after reloadPage() in the SAME AI turn.
  Before blocking, sends a notification to the user to trigger the page action.
  Editor line N → pass line=N-1 (CDP uses 0-based line numbers).
  Relay the "_ui" field from the response to the user once it returns.`,
    {
      urlFragment: z.string()
        .describe("Substring of the script URL where debugger; was added (e.g. 'LoginForm.vue', 'utils.ts'). Does NOT need to be the full URL."),
      line: z.number().int().nonnegative()
        .describe("0-based line number where debugger; was inserted. Editor line N → pass N-1."),
      timeout: z.number().int().positive().optional()
        .describe("Timeout in ms to wait for any pause (default 90000). Increase for slow interactions."),
      // 行号容差，打包代码可能需要调大
      lineTolerance: z.number().int().nonnegative().optional()
        .describe("±line tolerance for Tier 1 matching (default 10). Increase to 20+ for heavily bundled code."),
      // 可选的操作提示，用于通知用户在页面上执行什么操作来触发断点
      actionHint: z.string().optional()
        .describe("Describe the page action to trigger the breakpoint (e.g. 'click the Search button'). Shown in the waiting notification to the user."),
    },
    async ({ urlFragment, line, timeout, lineTolerance, actionHint }) => {
      const timeoutMs = timeout ?? DEFAULT_SPECIFIC_PAUSE_TIMEOUT_MS;
      const targetDescription = `"${urlFragment}" near line ${line}`;
      const clearReminder = scheduleUserActionReminder(
        actionHint,
        timeoutMs,
        targetDescription,
      );
      try {
        await sendUserActionPrompt(
          "ACTION REQUIRED",
          actionHint,
          timeoutMs,
          targetDescription,
        );
  
        // 阻塞等待下一次暂停（不自动 resume，不循环）
        const result = await manager.waitForSpecificPause(
          urlFragment,
          line,
          timeoutMs,
          lineTolerance ?? 10,
        );
  
        // 根据匹配结果给 AI 不同的后续指引
        const uiMessage = result.matched
          ? `Breakpoint hit ✓\n${result.note}\nCall getScopeVariables() now.`
          : `Paused at wrong location ✗\n${result.note}`;
  
        return ok({
          ...result,
          _ui: {
            status: result.matched ? "Breakpoint hit" : "Wrong pause location",
            message: uiMessage,
          },
        });
      } catch (e: any) {
        return fail(e.message);
      } finally {
        clearReminder();
      }
    },
  );
  
  // ── getScopeVariables ──────────────────────────────────────
  // 步骤6a：读取当前暂停帧的所有作用域变量
  server.tool(
    "getScopeVariables",
    `[STEP 6a] Read all scope variables (local, closure, module) at the currently paused call frame.
  Call this immediately after waitForSpecificPause or waitForPause returns.
  Results are grouped by scope type; global scope is skipped.
  Use frameIndex=1, 2, ... to inspect variables in parent call frames up the stack.`,
    {
      frameIndex: z.number().int().nonnegative().optional()
        .describe("Call frame index (default 0, the topmost frame)"),
    },
    async ({ frameIndex }) => {
      try {
        const scopes = await manager.getScopeVariables(frameIndex ?? 0);
        return ok({ frameIndex: frameIndex ?? 0, scopes });
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );
  
  // ── evaluate ───────────────────────────────────────────────
  // 步骤6b：在断点处执行任意 JS 表达式，深入检查对象
  server.tool(
    "evaluate",
    `[STEP 6b] Evaluate any JavaScript expression in the context of the currently paused call frame.
  Use this to inspect nested objects, call methods, compute derived values, or verify conditions at runtime.
  Complements getScopeVariables for values not directly visible in scope (e.g. this.state, JSON.stringify(obj)).`,
    {
      expression: z.string().describe("JavaScript expression to evaluate"),
      frameIndex: z.number().int().nonnegative().optional()
        .describe("Call frame index (default 0)"),
    },
    async ({ expression, frameIndex }) => {
      try {
        const result = await manager.evaluate(expression, frameIndex ?? 0);
        return ok(result);
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );
  
  // ── resume ─────────────────────────────────────────────────
  // 步骤8：恢复执行，调试结束后清理临时 debugger; 语句
  server.tool(
    "resume",
    `[STEP 8] Resume script execution after collecting all needed variable data — ends the current pause.
  After calling resume, remove all temporary debugger; statements added to source code during this session.
  Relay the "_ui" field from the response to the user.`,
    {},
    async () => {
      try {
        await manager.resume();
        return ok({
          message: "Execution resumed",
          _ui: {
            status: "Step 8: Session complete",
            message: "Execution resumed. Cleaning up temporary debugger; statements from source code now.",
          },
        });
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );
  
  // ── stepInto ───────────────────────────────────────────────
  // 步骤7选项：单步进入函数内部
  server.tool(
    "stepInto",
    "[STEP 7] BLOCKING: step into the next function call, then wait until the debugger pauses again. Follow with getScopeVariables() to observe inner-function state.",
    {
      timeout: z.number().int().positive().optional()
        .describe("Timeout in milliseconds to wait for the next pause (default 30000)"),
    },
    async ({ timeout }) => {
      try {
        const info = await manager.stepInto(timeout);
        return ok({
          message: "Stepped into and paused again",
          reason: info.reason,
          callStack: manager.getCallStackSummary(),
        });
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );
  
  // ── stepOver ───────────────────────────────────────────────
  // 步骤7选项：单步跳过，不进入函数调用
  server.tool(
    "stepOver",
    "[STEP 7] BLOCKING: step over the current statement without entering function calls, then wait until the debugger pauses again. Follow with getScopeVariables() to observe how local variables change.",
    {
      timeout: z.number().int().positive().optional()
        .describe("Timeout in milliseconds to wait for the next pause (default 30000)"),
    },
    async ({ timeout }) => {
      try {
        const info = await manager.stepOver(timeout);
        return ok({
          message: "Stepped over and paused again",
          reason: info.reason,
          callStack: manager.getCallStackSummary(),
        });
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );
  
  // ── stepOut ────────────────────────────────────────────────
  // 步骤7选项：单步跳出当前函数，回到调用处
  server.tool(
    "stepOut",
    "[STEP 7] BLOCKING: step out of the current function and wait until the debugger pauses again in the caller. Use to observe the return value and the state of the calling context.",
    {
      timeout: z.number().int().positive().optional()
        .describe("Timeout in milliseconds to wait for the next pause (default 30000)"),
    },
    async ({ timeout }) => {
      try {
        const info = await manager.stepOut(timeout);
        return ok({
          message: "Stepped out and paused again",
          reason: info.reason,
          callStack: manager.getCallStackSummary(),
        });
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );
  
  // ── getStatus ──────────────────────────────────────────────
  // 非阻塞状态查询，适用于客户端有短超时限制的轮询场景
  server.tool(
    "getStatus",
    `Non-blocking: return current connection and pause state immediately without waiting.
  Use this to poll for pause instead of waitForPause when the MCP client has a short request timeout (e.g. MCP Inspector ~10s).
  Returns: connected, paused, targetUrl, pauseReason, hitBreakpoints, callStack.`,
    {},
    () => {
      try {
        return ok(manager.getStatus());
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );
  
  // ── reloadPage ─────────────────────────────────────────────
  // 步骤5a：通过 CDP 重载页面，确保断点正确绑定
  // ⚠️ 重要：返回后必须在同一轮次立刻调用 waitForSpecificPause，不能结束对话轮次
  server.tool(
    "reloadPage",
    `[STEP 5a] Reload the connected page via Chrome DevTools Protocol.
  More reliable than manual browser refresh — maintains the CDP connection and ensures debugger; statements and setBreakpoint() calls resolve correctly when scripts reload.
  Always call this after inserting debugger; in source code or after setBreakpoint(), before waitForSpecificPause/waitForPause.
  
  ⚠️ CRITICAL TURN RULE: After this tool returns, you MUST immediately call waitForSpecificPause (or waitForPause) in the SAME AI turn — do NOT end your turn here.
  waitForSpecificPause is a blocking call that will notify the user to trigger the page action and wait for the breakpoint internally.
  If you end your turn after reloadPage, the session will break.`,
    {
      ignoreCache: z.boolean().optional()
        .describe("Hard reload ignoring cache (default false)"),
    },
    async ({ ignoreCache }) => {
      try {
        const msg = await manager.reloadPage(ignoreCache ?? false);
        return ok({
          message: msg,
          // _ui 不包含"请操作页面"——那条提示由 waitForSpecificPause 通过 logging 发出
          // 这里只告诉 AI 下一步做什么，促使它立刻继续调用，而不是结束轮次
          _ui: {
            status: "Step 5a: Reload requested — calling waitForSpecificPause now",
            message: "Reload requested. Now calling waitForSpecificPause to block and wait for the breakpoint...",
            nextAction: "IMMEDIATELY call waitForSpecificPause in this same turn — do not end your turn.",
          },
        });
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );

  // ── forcePause ─────────────────────────────────────────────
// 强制在下一条 JS 语句处暂停，适用于无法修改源码的场景
server.tool(
    "forcePause",
    "Force the debugger to pause at the very next JavaScript statement. Useful when you cannot modify source code to add debugger; and setBreakpoint is not feasible.",
    {},
    async () => {
      try {
        await manager.pause();
        return ok({
          message: "Pause requested – execution will pause at next statement",
          _ui: {
            status: "Force pause requested",
            message: "Pause requested. The debugger will stop at the next JavaScript statement — please interact with the page to trigger execution.",
          },
        });
      } catch (e: any) {
        return fail(e.message);
      }
    },
  );
  
  // ── 启动服务器 ─────────────────────────────────────────────
  async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("chrome-debugger-mcp server running on stdio");
  }
  
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });