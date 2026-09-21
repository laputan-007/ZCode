# 远程模型列表探测（Remote Model List）

设置 → 模型管理 → Provider「模型列表」区的「获取模型列表」能力：向 Provider 的 Base URL 解析出的 models 端点发一次 GET，把 OpenAI 风格的模型清单交给用户多选，批量添加为该 Provider 的 Personal Model。

## 产品规则

- 入口是 Provider 卡片「模型列表」区标题行上与「添加模型」**并列**的独立按钮；点击后打开独立的清单对话框并立即发起一次拉取，不要求用户再点第二次。
- 「添加模型」/「编辑模型」弹窗本身不承载该入口，两条路径互不干扰。
- 一次打开 = 一次请求；对话框内的「重试」再发一次。不轮询、不后台刷新、不缓存结果；关闭对话框即丢弃。
- 拉取结果只是**候选**。用户勾选后逐条走既有 `addPersonalModel` 写入路径，沿用「智能推荐配置」，不新增第二条写入路径。
- 已存在于该 Provider 的模型 id 在候选列表中禁用并标注「已添加」，不可重复勾选。
- 列表上方提供「全选 / 取消全选」三态开关（全选 / 部分选中 / 未选）与「已选 n/m」计数，沿用 `ExternalAgentImportDialog` 的既有交互语义。全选只作用于**可添加**的候选，已存在的模型不参与，因此 m 可能小于接口返回条数；无可添加候选时开关禁用。
- 提交集 = 勾选集 ∩ 可添加集。即使另一条路径（手工「添加模型」）刚写入过同名模型，残留的勾选也不会被重复提交。
- Base URL、API Key、自定义 headers、API 协议类型一律取自 Provider 的 **Effective Config**（Registry 视图），不接受 renderer 传值。

## 状态所有者

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| Base URL / Key / headers / api.type | `ProviderRegistryService`（经 `ProviderSettingsFacade.getView()`） | 唯一配置真相；连接字段在失焦时已自动保存 |
| 探测状态机 `idle/loading/ready/error` | `ProviderRemoteModelListPicker` 组件本地 state | 不写任何 Zustand store；UI 局部状态不是服务端事实 |
| 已选中的候选 id | 同上，组件本地 state | 提交成功后清空 |
| Personal Model 落库 | `ProviderConfigRuntime` → Registry | 由既有 `addPersonalModel` 命令承担 |

Renderer 侧不保留第二份模型清单缓存；重新打开弹窗必须重新拉取。

## 端点解析规则

输入为 Effective Config 的 `api.baseUrl`。仓库约定 Base URL 通常已含 `/v1`（输入框 placeholder 即 `https://api.example.com/v1`；Anthropic 侧 `normalizeAnthropicBaseURL` 同样遵循「已含 `/v1` 则不重复添加」）。因此不做字面直拼，避免出现 `/v1/v1/models`：

1. `trim()` 并去掉尾部所有 `/`；无法解析为 URL、或协议不是 `http:` / `https:` → 解析失败（`base-url-missing`）
2. pathname 已以 `/models` 结尾 → 原样使用（用户直接粘贴了完整地址）
3. pathname 已以 `/v1` 结尾 → 追加 `/models`
4. 其他 → 追加 `/v1/models`

保留原有 query 与 hash 不做处理（Provider Base URL 不应携带 query；若携带则原样透传，由服务端决定）。

`ProviderDraftSave.ts` 里的「折叠重复 URL」是针对**历史脏数据**的落盘前修复，写入时已生效；本探测读取的是已修复的 Effective Config，因此不重复实现该逻辑（且 services 不得反向依赖 ui）。

## 请求头矩阵

| `api.type` | 头 |
| --- | --- |
| `openai-chat-completions` / `openai-responses` | `Authorization: Bearer <normalizeApiKeyForHeader(apiKey)>` |
| `anthropic-messages` | `x-api-key: <key>`、`anthropic-version: 2023-06-01`，并按 `withAnthropicAuthorizationHeader` 的既有约定补 `Authorization: Bearer <key>`（兼容网关两者都读） |

- Effective Config 的 `api.headers` 最后叠加，**用户显式配置的同名头优先**，探测头不覆盖它（对齐 `model-execution.ts` 的 `hasHeader` 判定）。
- `access.type === "zhipu-account"`：账号类 Provider 没有用户可填的 Key，直接返回 `unsupported-access`，不猜凭证。
- api-key 类 Provider 即使 Key 为空也照发请求（部分网关不鉴权），失败由服务端状态码决定。

## 响应解析

只接受 OpenAI 风格清单，用 zod 运行时校验（跨进程/网络边界不得只靠 TS 类型）：

```jsonc
{ "object": "list", "data": [ { "id": "GLM-5.3", "object": "model", "created": 1677610602, "owned_by": "openai" } ] }
```

- `data` 必须是数组，元素 `id` 必须是非空字符串；`object` / `created` / `owned_by` 可选。
- `id` 去重并保持服务端返回顺序。
- `data` 缺失、不是数组、或没有任何合法 `id` → `invalid-response`。
- 顶层 `object` 字段不做断言（部分兼容网关返回 `models` 或省略）。

## 失败语义

| code | 触发条件 |
| --- | --- |
| `base-url-missing` | Effective Config 没有可用 `api.baseUrl`，或端点解析失败 |
| `unsupported-access` | `access.type` 不是 api-key 类（如 `zhipu-account`），没有用户可填的 Key |
| `provider-unavailable` | Provider 不存在、已停用，或 `api.type` 尚未配置完整 |
| `capability-unavailable` | 当前 Environment 未装配探测能力；或远程 Environment 版本较旧、RPC 方法不存在 |
| `http-error` | 非 2xx，携带 `status` |
| `invalid-response` | 响应体不是合法 JSON，或不符合上面的清单结构 |
| `network-error` | 建连失败（`isNetworkFailure` 判定的错误码） |
| `timeout` | 超过 `REMOTE_MODEL_LIST_TIMEOUT_MS` |

错误一律以结构化 `RemoteModelListResult` 返回，**不向 renderer 抛异常**；UI 按 code 映射本地化文案并附服务端 message。

远程 Environment 若运行旧版本 server，`IProviderSettingsService.fetchRemoteModelList` 会因 method-not-found 而 reject；hook 边界捕获并归一化为 `capability-unavailable`，不得让设置页崩溃。

## 幂等与竞态

- 请求本身只读，天然幂等。
- 组件用递增 requestId 守卫：用户连续点击时旧响应必须丢弃，避免旧结果覆盖新状态（与 `useModelProviders.refresh` 的 token 守卫同理）。
- 批量添加串行执行，单条失败即中断，并把「已成功 k / 共 n 条」带进错误信息；已成功写入的模型不回滚（写入本身是幂等的按 id 覆盖，用户可重试剩余部分）。

## 安全与日志

- 任何日志级别都**不写 apiKey**。`debug` 只记 url、status、header 的 key 列表（对齐 `nodeApiClient.ts` 的既有约定）。
- 探测由用户显式点击触发，单次 GET，不跟随重定向到非 http(s) 目标。Base URL 可能指向内网，这是用户对自己配置的动作，不额外做地址白名单。
- 错误 message 取自响应体的 `error`（字符串或 OpenAI 风格 `{ message }` 对象）、`message`、`msg`、`detail` 字段，都取不到时退回 `HTTP <status>`；非 JSON 响应体（网关 HTML 错误页）会压缩空白并截断到 `MAX_ERROR_MESSAGE_LENGTH`，不把整页灌进设置页弹窗。

## 验收场景

1. openai-chat-completions Provider，Base URL `https://gateway.example.com/v1` → 请求 `https://gateway.example.com/v1/models`，9 条候选全部列出。
2. Base URL `https://gateway.example.com`（不含 `/v1`）→ 请求 `https://gateway.example.com/v1/models`。
3. Base URL 以 `/models` 结尾 → 原样请求，不重复拼接。
4. anthropic-messages Provider → 同时带 `x-api-key`、`anthropic-version`、`Authorization`。
5. 用户在 `api.headers` 里配了自定义 `Authorization` → 以用户值为准。
6. 勾选 3 条（其中 1 条已存在被禁用不可选）→ 串行写入 2 条，列表刷新后可见且可被选用。
7. 全选：接口返回 9 条、其中 2 条已存在 → 计数显示「已选 0/7」；点「全选」→「已选 7/7」且文案变「取消全选」；再点 → 归零。只勾 3 条时开关呈部分选中态。
8. 失败路径：Base URL 为空 / 401 / 返回体不是 list 结构 / 断网 / 超时 / 远程旧版本 —— 各自呈现对应文案，设置页不崩，可重试。
