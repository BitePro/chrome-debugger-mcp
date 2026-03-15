# chrome-debugger-mcp

[English](#english) | [中文](#chinese)

<a id="english"></a >

## English

An MCP server for breakpoint-driven Chrome debugging.

`chrome-debugger-mcp` exposes Chrome DevTools Protocol primitives as MCP tools so an AI agent can attach to a real Chrome tab, pause execution, inspect runtime values, evaluate expressions inside the current call frame, and step through code instead of guessing from static source.

This server is built for questions like:

- What is this variable at runtime?
- Why did this branch execute?
- What does the real API payload look like in the browser?
- Which function changed this state?
- Why does the UI fail only after a specific click or reload?

It is not a general browser automation server. The focus is runtime debugging.

### Features

- Launch a dedicated Chrome instance with remote debugging enabled
- List open tabs and require explicit user confirmation before connecting
- Connect to a specific Chrome page over CDP
- Set and remove DevTools breakpoints without editing source code
- Reload the page through CDP so breakpoints reliably bind after navigation
- Wait for the next pause, or wait for a specific file and line target
- Read scope variables from the paused frame
- Evaluate arbitrary JavaScript in the current call frame
- Step into, step over, step out, and resume execution
- Poll debugger state when the MCP client has short request timeouts
- Emit `_ui` payloads and logging messages that clients can surface to the user

### Why This Exists

Browser-focused MCP tools are usually good at DOM interaction and network inspection, but weak at answering runtime debugging questions. This project gives an MCP client access to the debugging workflow you would normally use in Chrome DevTools:

1. Attach to the right tab.
2. Pause execution at the right moment.
3. Read actual runtime values.
4. Step through code if needed.
5. Resume and clean up.

The server is intentionally opinionated. It encodes guardrails that prevent common agent mistakes such as:

- guessing which tab to attach to
- concluding behavior without inspecting runtime values
- ending the turn between `reloadPage()` and `waitForSpecificPause()`

### Requirements

- Google Chrome installed locally
- An MCP client that supports stdio servers and tool calling
- Access to the application you want to debug
- Local source access if you plan to insert temporary `debugger;` statements

### Installation

#### From npm

After this package is published, users can run it directly with `npx`:

```bash
npx -y chrome-debugger-mcp
```

Or install it globally:

```bash
npm install -g chrome-debugger-mcp
```

#### From source

```bash
pnpm install
pnpm build
node dist/index.js
```

### MCP Client Configuration

#### Use the published package

```json
{
  "mcpServers": {
    "chrome-debugger": {
      "command": "npx",
      "args": ["-y", "chrome-debugger-mcp"]
    }
  }
}
```

#### Use a local checkout

```json
{
  "mcpServers": {
    "chrome-debugger": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-debugger-mcp/dist/index.js"]
    }
  }
}
```

### Tooling Model

The server runs over stdio and exposes MCP tools. The most important tools are:

- `startDebuggingSession`: returns the recommended debugging workflow and critical rules for agent behavior
- `launchChrome`: launches a dedicated Chrome instance with remote debugging enabled
- `listTargets`: lists available Chrome tabs and requires the user to pick one
- `connect`: attaches to the confirmed tab
- `setBreakpoint`: creates a CDP breakpoint without modifying source files
- `removeBreakpoint`: removes a breakpoint created by `setBreakpoint`
- `reloadPage`: reloads the current page through CDP
- `waitForSpecificPause`: waits for the next pause and checks whether it matches a target file and line
- `waitForPause`: waits for any pause without location matching
- `getScopeVariables`: reads local, closure, and module scope values from the paused frame
- `evaluate`: executes JavaScript in the paused call frame
- `stepInto`, `stepOver`, `stepOut`: standard execution control
- `resume`: resumes execution after inspection
- `getStatus`: non-blocking polling for connected or paused state
- `forcePause`: requests a pause at the next JavaScript statement

### Recommended Workflow

For AI clients, the intended flow is:

1. Call `startDebuggingSession()`.
2. Call `launchChrome()` or use an already-running Chrome instance with a CDP port.
3. Call `listTargets()` and show the full tab list to the user.
4. Wait for the user to confirm the exact page URL.
5. Call `connect({ targetUrl })`.
6. Insert a temporary `debugger;` statement in local source code, or call `setBreakpoint()`.
7. Call `reloadPage()`.
8. Immediately call `waitForSpecificPause()` in the same turn.
9. Call `getScopeVariables()` and `evaluate()` to inspect runtime values.
10. Step if necessary with `stepInto()`, `stepOver()`, or `stepOut()`.
11. Call `resume()`.
12. Remove any temporary `debugger;` statements from source code.

### Important Rules For Agent Authors

This server is designed for tool-using agents, not only for humans. If you are integrating it into an MCP client, keep these rules:

- Never skip `listTargets()`.
- Never guess the target URL, even if only one tab is open.
- Always wait for explicit user confirmation before `connect()`.
- After `reloadPage()`, immediately call `waitForSpecificPause()` or `waitForPause()` in the same turn.
- Do not explain behavior from static code when runtime values can be inspected directly.
- Always `resume()` after inspection.
- If you added temporary `debugger;` statements to source code, remove them before finishing.

### How `waitForSpecificPause` Matches

`waitForSpecificPause` is the preferred waiting primitive because it is more reliable than waiting for an arbitrary pause.

It matches a pause using two strategies:

1. URL fragment plus line tolerance
2. URL fragment plus `debugger-statement` pause reason

The second path matters when source maps, transpilation, or bundling shift compiled line numbers away from editor line numbers.

### Example Tool Sequence

An agent debugging a local Vite app might do something like this:

1. `launchChrome({ dryRun: true })`
2. `launchChrome()`
3. `listTargets()`
4. Wait for the user to confirm `http://127.0.0.1:5173`
5. `connect({ targetUrl: "127.0.0.1:5173" })`
6. Insert `debugger;` in `App.jsx`
7. `reloadPage()`
8. `waitForSpecificPause({ urlFragment: "App.jsx", line: 62, actionHint: "click the Refetch payloads button" })`
9. `getScopeVariables()`
10. `evaluate({ expression: "payload.modules" })`
11. `resume()`

### Chrome Launch Behavior

`launchChrome()` uses a dedicated profile so it does not interfere with the user's normal browser session.

Defaults:

- remote debugging port: `9222`
- profile directory: `~/.chrome-debug-profile`

Expected Chrome binary locations:

- macOS: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Linux: `google-chrome`
- Windows: `C:\Program Files\Google\Chrome\Application\chrome.exe`

If automatic launch fails, the tool returns a command the user can run manually.

### Local Playground

This repository includes a disposable test app under [`test/`](./test) so you can exercise the debugger server against a realistic browser workflow.

#### Start the mock service

```bash
cd test/service
node src/server.js
```

The service listens on `http://127.0.0.1:3030`.

#### Start the web app

```bash
cd test/web
pnpm install
pnpm dev
```

The web app runs on `http://127.0.0.1:5173`.

Useful places to pause:

- `test/web/src/App.jsx` inside `loadWorkbench`
- `test/web/src/App.jsx` inside `loadModuleDetail`
- `test/web/src/App.jsx` around the unfinished detail sections

Runtime payload areas worth inspecting:

- `summaryCards`
- `modules`
- `apiContracts`
- `nextActions`
- `responseShape`

### Troubleshooting

#### No targets found

Make sure Chrome is running with `--remote-debugging-port=9222` and the target page is open.

#### More than one tab matches `targetUrl`

Pass a more specific substring so the match becomes unique.

#### `waitForPause` or `waitForSpecificPause` times out

This can happen when:

- the page action was never triggered
- the wrong breakpoint was set
- the MCP client itself has a shorter request timeout than the tool call

If your client times out quickly, use `getStatus()` to poll or increase the client timeout.

#### The paused line number does not match the editor line

Bundlers and transpilers can shift compiled line numbers. Use `waitForSpecificPause()` and rely on URL fragment matching plus `debugger-statement` semantics.

#### Chrome does not launch automatically

The machine may use a non-default Chrome install path. Run the returned launch command manually or adjust the implementation to match your environment.

### Development

```bash
pnpm install
pnpm build
node dist/index.js
```

The implementation lives in:

- [`src/index.ts`](./src/index.ts): MCP tool definitions and user-facing workflow hints
- [`src/chrome-manager.ts`](./src/chrome-manager.ts): Chrome DevTools Protocol integration and debugger state management

### License

MIT

<a id="chinese"></a >

## 中文

一个面向 Chrome 断点调试的 MCP Server。

`chrome-debugger-mcp` 把 Chrome DevTools Protocol 的核心调试能力暴露为 MCP 工具，让 AI agent 可以连接真实的 Chrome 标签页，在运行时暂停执行、读取变量、在当前调用帧中执行表达式、单步跟踪代码，而不是只靠静态源码猜测行为。

这个服务适合处理这类问题：

- 这个变量在运行时到底是什么值？
- 为什么会走到这个分支？
- 浏览器里真实拿到的 API 返回结构是什么？
- 是哪一个函数改掉了这个状态？
- 为什么这个 UI 只有在某次点击或刷新后才出错？

它不是通用浏览器自动化工具。它的重点是运行时调试。

### 功能特性

- 启动带远程调试端口的独立 Chrome 实例
- 列出所有标签页，并强制要求用户明确确认目标页
- 通过 CDP 连接指定 Chrome 页面
- 无需修改源码即可设置和移除断点
- 通过 CDP 重载页面，确保跳转后断点可靠绑定
- 支持等待任意 pause，也支持等待指定文件和行附近的 pause
- 读取当前暂停帧里的作用域变量
- 在当前调用帧里执行任意 JavaScript 表达式
- 支持 `stepInto`、`stepOver`、`stepOut` 和 `resume`
- 当 MCP 客户端请求超时较短时，可轮询调试器状态
- 输出 `_ui` 结果和 logging 消息，方便客户端展示给用户

### 为什么做这个项目

很多浏览器方向的 MCP 工具更擅长 DOM 操作和网络请求观察，但不擅长回答运行时调试问题。这个项目把 Chrome DevTools 中常用的调试流程带进了 MCP：

1. 连接正确的标签页。
2. 在正确的时机暂停执行。
3. 读取真实运行时值。
4. 必要时单步跟踪。
5. 恢复执行并清理现场。

这个服务是有明确约束的。它内置了一些 guardrails，专门避免 agent 出现这些常见错误：

- 猜测应该连接哪个标签页
- 没看运行时值就直接下结论
- 在 `reloadPage()` 和 `waitForSpecificPause()` 之间错误地结束当前轮次

### 运行要求

- 本机安装了 Google Chrome
- 使用支持 stdio MCP server 和工具调用的 MCP 客户端
- 可以访问你要调试的应用
- 如果要插入临时 `debugger;`，需要能访问本地源码

### 安装方式

#### 从 npm 使用

这个包发布后，用户可以直接用 `npx` 运行：

```bash
npx -y chrome-debugger-mcp
```

也可以全局安装：

```bash
npm install -g chrome-debugger-mcp
```

#### 从源码运行

```bash
pnpm install
pnpm build
node dist/index.js
```

### MCP 客户端配置

#### 使用已发布包

```json
{
  "mcpServers": {
    "chrome-debugger": {
      "command": "npx",
      "args": ["-y", "chrome-debugger-mcp"]
    }
  }
}
```

#### 使用本地源码

```json
{
  "mcpServers": {
    "chrome-debugger": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-debugger-mcp/dist/index.js"]
    }
  }
}
```

### 工具模型

这个服务通过 stdio 运行，并暴露一组 MCP tools。最核心的工具有：

- `startDebuggingSession`：返回推荐调试流程和 agent 行为约束
- `launchChrome`：启动带远程调试能力的独立 Chrome 实例
- `listTargets`：列出可调试标签页，并要求用户做选择
- `connect`：连接到已确认的目标标签页
- `setBreakpoint`：在不改源码的情况下通过 CDP 设置断点
- `removeBreakpoint`：移除通过 `setBreakpoint` 创建的断点
- `reloadPage`：通过 CDP 重载当前页面
- `waitForSpecificPause`：等待下一次暂停，并判断是否命中目标文件和行
- `waitForPause`：不做位置匹配，等待任意暂停
- `getScopeVariables`：读取当前暂停帧中的局部、闭包、模块作用域变量
- `evaluate`：在暂停调用帧中执行 JavaScript
- `stepInto`、`stepOver`、`stepOut`：标准单步控制
- `resume`：检查完毕后恢复执行
- `getStatus`：非阻塞方式查询是否已连接、是否已暂停
- `forcePause`：请求在下一条 JavaScript 语句处暂停

### 推荐工作流

对于 AI 客户端，建议流程是：

1. 调用 `startDebuggingSession()`。
2. 调用 `launchChrome()`，或直接复用已经开启 CDP 端口的 Chrome。
3. 调用 `listTargets()`，并把完整标签页列表展示给用户。
4. 等待用户明确确认要调试的页面 URL。
5. 调用 `connect({ targetUrl })`。
6. 在本地源码插入临时 `debugger;`，或者调用 `setBreakpoint()`。
7. 调用 `reloadPage()`。
8. 在同一轮里立刻调用 `waitForSpecificPause()`。
9. 调用 `getScopeVariables()` 和 `evaluate()` 检查运行时值。
10. 必要时使用 `stepInto()`、`stepOver()`、`stepOut()` 继续跟踪。
11. 调用 `resume()`。
12. 删除源码里临时加入的 `debugger;`。

### 给 Agent 作者的重要规则

这个服务首先是为会调用工具的 agent 设计的，而不仅仅是给人手动点工具用。如果你要把它接入自己的 MCP 客户端，建议遵守这些规则：

- 不要跳过 `listTargets()`。
- 即使只看到一个标签页，也不要猜测目标 URL。
- 一定要等用户明确确认后再调用 `connect()`。
- 调用 `reloadPage()` 后，必须在同一轮里立刻调用 `waitForSpecificPause()` 或 `waitForPause()`。
- 能读取运行时值时，不要只根据静态代码解释行为。
- 检查完之后一定要 `resume()`。
- 如果向源码里插入了临时 `debugger;`，结束前要清理掉。

### `waitForSpecificPause` 如何匹配

`waitForSpecificPause` 是首选的等待工具，因为它比“等待任意暂停”更可靠。

它有两层匹配策略：

1. URL 片段加行号容差
2. URL 片段加 `debugger-statement` 暂停原因

第二层匹配对经过 source map、转译、打包后的代码尤其重要，因为编译后的行号可能和编辑器行号不完全一致。

### 调用序列示例

一个 agent 调试本地 Vite 应用时，调用顺序大致会像这样：

1. `launchChrome({ dryRun: true })`
2. `launchChrome()`
3. `listTargets()`
4. 等用户确认 `http://127.0.0.1:5173`
5. `connect({ targetUrl: "127.0.0.1:5173" })`
6. 在 `App.jsx` 插入 `debugger;`
7. `reloadPage()`
8. `waitForSpecificPause({ urlFragment: "App.jsx", line: 62, actionHint: "click the Refetch payloads button" })`
9. `getScopeVariables()`
10. `evaluate({ expression: "payload.modules" })`
11. `resume()`

### Chrome 启动行为

`launchChrome()` 会使用独立 profile，不会影响用户平时正在用的浏览器会话。

默认值：

- 远程调试端口：`9222`
- profile 目录：`~/.chrome-debug-profile`

默认 Chrome 可执行文件路径：

- macOS：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- Linux：`google-chrome`
- Windows：`C:\Program Files\Google\Chrome\Application\chrome.exe`

如果自动启动失败，工具会返回一条可供用户手动执行的启动命令。

### 本地 Playground

仓库里带了一个可丢弃的测试应用，目录在 [`test/`](./test)。你可以直接用它验证这个调试 MCP 的完整链路。

#### 启动 mock service

```bash
cd test/service
node src/server.js
```

服务监听在 `http://127.0.0.1:3030`。

#### 启动 web app

```bash
cd test/web
pnpm install
pnpm dev
```

Web 应用运行在 `http://127.0.0.1:5173`。

建议下断点的位置：

- `test/web/src/App.jsx` 里的 `loadWorkbench`
- `test/web/src/App.jsx` 里的 `loadModuleDetail`
- `test/web/src/App.jsx` 里尚未完成的 detail 区域附近

值得在运行时查看的 payload 字段：

- `summaryCards`
- `modules`
- `apiContracts`
- `nextActions`
- `responseShape`

### 故障排查

#### 找不到 targets

确认 Chrome 是用 `--remote-debugging-port=9222` 启动的，并且目标页面已经打开。

#### `targetUrl` 匹配到多个标签页

传入更具体的 URL 子串，保证匹配结果唯一。

#### `waitForPause` 或 `waitForSpecificPause` 超时

常见原因包括：

- 页面操作没有真正触发
- 断点位置不对
- MCP 客户端自身的请求超时时间比工具调用更短

如果客户端超时比较短，可以改用 `getStatus()` 轮询，或者调大客户端超时。

#### 暂停时的行号和编辑器对不上

打包和转译会导致编译后的行号偏移。优先使用 `waitForSpecificPause()`，并依赖 URL 片段匹配加 `debugger-statement` 语义匹配。

#### Chrome 无法自动启动

机器上的 Chrome 安装路径可能不是默认值。可以直接运行工具返回的启动命令，或者按你的环境调整实现。

### 开发

```bash
pnpm install
pnpm build
node dist/index.js
```

主要实现文件：

- [`src/index.ts`](./src/index.ts)：MCP 工具定义和面向用户的工作流提示
- [`src/chrome-manager.ts`](./src/chrome-manager.ts)：Chrome DevTools Protocol 集成和调试状态管理

### 许可证

MIT