# 新增一个第三方对话来源（provider）

本插件（dsh-agent-session-import）把「读取某个第三方 agent 本地历史 → 标准化 → 写成 DSH 会话」拆成了 provider 插件。
接一个新来源（例如 zcode、Aider、Continue……）只需要**加一个文件**，面板、进度、结果、去重、
投影缓存预热等全部自动复用。

## 1. 目录与注册

provider 放在 `lib/host/providers/<id>.js`，然后在 `lib/host/providers/registry.js` 的
`OPTIONAL_PROVIDERS` 里加一行：

```js
const OPTIONAL_PROVIDERS = [
  { name: 'codex', module: './codex.js' },
  { name: 'claude-code', module: './claude-code.js' },
  { name: 'zcode', module: './zcode.js' },
  { name: 'kimi', module: './kimi.js' },
  // ← 新增来源在这里加一行
];
```

文件不存在时会被安全跳过，不影响其他来源。

## 2. 必须导出的接口

模块是纯 ESM，只允许 `node:` 内置模块或相对引用（不要引入第三方包）：

```js
export const id = 'zcode';                 // 来源 id：小写、稳定，用于 UI/去重/存储 key（不允许冒号）
export const label = 'ZCode';              // 面板 tab 上显示的名字
export const description = '一句话说明';     // tab tooltip

/** 数据是否可读。 */
export async function status() {
  return { available: true, location: '~/.zcode/history', error: null };
}

/** 列出可导入对话（用于选择列表；可以慢一点，但要容忍坏文件）。 */
export async function list() {
  return [{
    id: 'session-123',          // 来源内唯一 id
    title: '对话标题',
    cwd: '/absolute/project',   // 原项目目录；未知用 null
    cwdLabel: 'project',        // 展示用目录名
    createdAt: 1792385471733,   // 毫秒
    updatedAt: 1792471937030,
    messageCount: 42,           // 未知用 null
    isArchived: false,
  }];
}

/** 读取并标准化一条对话（返回下面的 Conversation）。 */
export async function load(conversationId) { /* ... */ }
```

建议直接复用 `lib/host/providers/shared.js` 的工具：
`clamp()`（截断）、`toMillis()`、`cleanTitle()`、`cwdLabel()`、`textContent()`。

## 3. 标准化后的对话模型（Conversation）

```ts
type Conversation = {
  source: string;              // = provider id
  id: string;
  title: string;
  createdAt: number;           // ms
  updatedAt: number;
  cwd: string | null;
  messageCount: number;
  turns: Turn[];
};

type Turn = {
  at: number;                                   // ms
  user: { content: [{ type: 'text'; text: string }] } | null;
  runs: Run[];                                  // 一轮里的模型回合（通常每个 assistant 消息一段）
};

type Run = {
  at: number;
  blocks: Array<
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool-call'; id: string; name: string; arguments: string }  // arguments 是 JSON 字符串
  >;
  toolResults: Array<{
    callId: string; name: string; arguments: string;
    output: string; isError: boolean; at: number;
  }>;
};
```

### 硬性不变量（writer 依赖，务必满足）

1. **tool-call id 在同一会话内唯一**；源数据重复时自行加后缀去重（如 `call_1~2`），
   block.id 与 toolResult.callId / name / arguments 必须三者一致。
2. `blocks` 里每个 `tool-call` 必须在同一 run 的 `toolResults` 里有**恰好一条**对应结果；
   历史里只有调用没有结果时补 `{ output: '[结果未记录]', isError: true }`；
   只有结果没有调用时补一个 tool-call block。
3. 一个 run 的 `blocks` 会渲染成一条 assistant 消息，`toolResults` 紧跟其后按顺序变成
   `tool/call` + `tool/result` 事件；文本/思考/工具调用按原始顺序放进同一个 run 的 `blocks`。
4. 工具输出 ≤ 20000 字符、思考 ≤ 12000 字符（用 `shared.js` 的 `clamp`），大文件用
   `node:readline` 流式读，单会话读取预算建议 240s。
5. 时间戳统一毫秒；`cwd` 用绝对路径（远程/容器路径可置 null，导入时会回退到用户 home）。

## 4. 写入 DSH 会话（框架负责，无需实现）

`lib/host/service.js` 会对每条 Conversation：

1. 用 `lib/host/writer.js` 把 turns/runs 变成 DSH v4 事件流：
   `turn/start → step/start → user/message → assistant/message → tool/call → tool/result → step/end → turn/end`，
   外加 `session/title`；
2. 通过 `ctx.sessionPersistence.create/append/flush/close` 持久化；
3. 通过 `ctx.sessionProjectionCache.write()` 预热投影缓存（标题/统计，冷列表也能显示标题）。

所以 provider 只负责**把源数据读成 Conversation**，不接触 DSH 内部 API。

## 5. 调试

```bash
# 单独跑 provider，不启动 DSH
node --input-type=module -e '
const p = await import("./lib/host/providers/<id>.js");
console.log(await p.status());
const rows = await p.list();
console.log(rows.length, rows.slice(0, 5));
const conv = await p.load(rows[0].id);
// 校验不变量：唯一 id / 每个 tool-call 有配对结果 / content 非空
'
```

再启动一个隔离实例做端到端验证（见 `research/harness/README.md`）：
侧边栏 Plugins → 安装本目录 → 面板里应自动出现新来源 tab，可 list/勾选/导入/看进度。
