import { z } from "zod";
import {
  type ApiClient,
  type RemoteModelListEntry,
  type RemoteModelListErrorCode,
  type RemoteModelListResult,
} from "@zcode/shared";
import type { ProviderApiType } from "@zcode/provider";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { normalizeApiKeyForHeader } from "#src/providers/api/index.js";
import {
  getNetworkErrorCodes,
  isNetworkFailure,
} from "#src/providers/api/networkErrorClassifier.js";

/** 详见 packages/services/docs/remote-model-list.md。 */
const REMOTE_MODEL_LIST_TIMEOUT_MS = 15_000;
/** 网关错误页可能是整段 HTML；截断后再进设置页弹窗。 */
const MAX_ERROR_MESSAGE_LENGTH = 300;
const ANTHROPIC_VERSION_HEADER_NAME = "anthropic-version";
const ANTHROPIC_VERSION_HEADER_VALUE = "2023-06-01";
const ANTHROPIC_API_KEY_HEADER_NAME = "x-api-key";
const AUTHORIZATION_HEADER_NAME = "Authorization";
const MODELS_PATH_SEGMENT = "/models";
const API_V1_PATH_SEGMENT = "/v1";

/** 探测目标只携带 Effective Config 的叶子值，适配器不认识 Registry。 */
export interface ProviderRemoteModelListTarget {
  readonly apiType: ProviderApiType;
  readonly baseUrl: string;
  readonly headers?: Record<string, string> | null;
  readonly apiKey?: string | null;
}

export type ProviderRemoteModelListFetcher = (
  target: ProviderRemoteModelListTarget,
) => Promise<RemoteModelListResult>;

/**
 * Base URL 通常已含 `/v1`（设置页 placeholder 即 `https://api.example.com/v1`），
 * 字面直拼会得到 `/v1/v1/models`。这里按 pathname 现状决定追加哪一段。
 */
function resolveModelListEndpoint(baseUrl: string): string | null {
  const trimmed = baseUrl.trim().replace(/\/+$/u, "");
  if (!trimmed) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  const lowercasePathname = pathname.toLowerCase();
  // 用户直接粘贴完整 models 地址时原样使用，不再拼接。
  if (lowercasePathname.endsWith(MODELS_PATH_SEGMENT)) {
    url.pathname = pathname;
    return url.href;
  }
  if (lowercasePathname.endsWith(API_V1_PATH_SEGMENT)) {
    url.pathname = `${pathname}${MODELS_PATH_SEGMENT}`;
    return url.href;
  }
  url.pathname = `${pathname}${API_V1_PATH_SEGMENT}${MODELS_PATH_SEGMENT}`;
  return url.href;
}

function hasHeaderKey(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

/**
 * 以用户显式配置的 `api.headers` 为基线，缺失时才补探测所需的鉴权头。
 * 反过来（探测头做基线）会让同名 header 以两种大小写同时存在，
 * fetch 构造 Headers 时按 ", " 合并，网关会收到拼坏的 Authorization。
 */
function buildModelListHeaders(target: ProviderRemoteModelListTarget): Record<string, string> {
  // 展开 null/undefined 在 JS 里等价于空对象，不需要额外兜底。
  const headers: Record<string, string> = { ...target.headers };
  const addIfAbsent = (name: string, value: string): void => {
    if (!hasHeaderKey(headers, name)) {
      headers[name] = value;
    }
  };
  const apiKey = normalizeApiKeyForHeader(target.apiKey ?? "");
  if (target.apiType === "anthropic-messages") {
    // Anthropic 兼容网关会同时读取 x-api-key 和 Bearer Authorization；两者都补，显式配置优先。
    if (apiKey) {
      addIfAbsent(ANTHROPIC_API_KEY_HEADER_NAME, apiKey);
      addIfAbsent(AUTHORIZATION_HEADER_NAME, `Bearer ${apiKey}`);
    }
    addIfAbsent(ANTHROPIC_VERSION_HEADER_NAME, ANTHROPIC_VERSION_HEADER_VALUE);
    return headers;
  }
  if (apiKey) {
    addIfAbsent(AUTHORIZATION_HEADER_NAME, `Bearer ${apiKey}`);
  }
  return headers;
}

const remoteModelListEntrySchema = z.object({
  id: z.string().trim().min(1),
  created: z.number().optional(),
  owned_by: z.string().optional(),
});

// 顶层只断言 data 是数组：部分兼容网关把 object 写成 "models" 或直接省略。
const remoteModelListEnvelopeSchema = z.object({
  data: z.array(z.unknown()),
});

/**
 * 逐条校验而不是整体 strict：单个畸形条目不应让整份清单作废，
 * 但一条合法 id 都没有时必须判定为结构不符。
 */
function parseOpenAiModelListPayload(payload: unknown): RemoteModelListEntry[] | null {
  const envelope = remoteModelListEnvelopeSchema.safeParse(payload);
  if (!envelope.success) {
    return null;
  }
  const entries: RemoteModelListEntry[] = [];
  const seen = new Set<string>();
  for (const item of envelope.data.data) {
    const parsed = remoteModelListEntrySchema.safeParse(item);
    if (!parsed.success || seen.has(parsed.data.id)) {
      continue;
    }
    seen.add(parsed.data.id);
    entries.push({
      id: parsed.data.id,
      ...(parsed.data.owned_by ? { ownedBy: parsed.data.owned_by } : {}),
      ...(parsed.data.created === undefined ? {} : { created: parsed.data.created }),
    });
  }
  return entries.length > 0 ? entries : null;
}

function failure(
  code: RemoteModelListErrorCode,
  message: string,
  status?: number,
): RemoteModelListResult {
  return {
    success: false,
    error: { code, message, ...(status === undefined ? {} : { status }) },
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createProviderRemoteModelListFetcher(dependencies: {
  readonly apiClient: ApiClient;
}): ProviderRemoteModelListFetcher {
  const log = createServiceLogger("provider-remote-model-list");
  return async (target) => {
    const endpoint = resolveModelListEndpoint(target.baseUrl);
    if (!endpoint) {
      return failure(
        "base-url-missing",
        "The configured Base URL cannot be resolved into a models endpoint.",
      );
    }
    const headers = buildModelListHeaders(target);
    log.debug(undefined, "remote model list request prepared", {
      endpoint,
      apiType: target.apiType,
      // 只记 header key，Authorization / x-api-key 的值不得落盘。
      headerKeys: Object.keys(headers).sort(),
    });
    // 超时判定由本适配器独占：自己持有 timer 与 abort，不依赖 ApiClient 的 timeoutMs，
    // 否则只能靠错误文本区分"超时"与"建连失败"。
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REMOTE_MODEL_LIST_TIMEOUT_MS);
    try {
      // 不用 readApiJson：它的错误消息提取只认扁平的 error/message/msg/detail，
      // 而 OpenAI 兼容网关普遍返回 { error: { message } }，最典型的 401（Key 错）
      // 会被压成 "HTTP 401"，用户在设置页看不到真正原因。这里就地判定状态与结构。
      const response = await dependencies.apiClient.request(endpoint, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      const rawBody = await response.text();
      if (!response.ok) {
        log.warn(undefined, "remote model list request rejected", {
          endpoint,
          status: response.status,
        });
        return failure(
          "http-error",
          readEndpointErrorMessage(rawBody, response.status),
          response.status,
        );
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        log.warn(undefined, "remote model list response is not JSON", {
          endpoint,
          status: response.status,
        });
        return failure(
          "invalid-response",
          "The endpoint returned a response that is not valid JSON.",
          response.status,
        );
      }
      const models = parseOpenAiModelListPayload(payload);
      if (!models) {
        log.warn(undefined, "remote model list response rejected", { endpoint });
        return failure(
          "invalid-response",
          "The endpoint did not return an OpenAI style model list.",
        );
      }
      log.info(undefined, "remote model list resolved", {
        endpoint,
        modelCount: models.length,
      });
      return { success: true, endpoint, models };
    } catch (error) {
      const result = classifyTransportFailure(endpoint, error, timedOut);
      log.warn(undefined, "remote model list request failed", {
        endpoint,
        code: result.success ? undefined : result.error.code,
        networkCodes: getNetworkErrorCodes(error),
        message: describeError(error),
      });
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * HTTP 状态与响应结构已在调用处就地判定，能走到这里的只剩传输层失败
 * （建连、DNS、中断）。未知传输异常同样归到 network-error，
 * 避免把网络问题误报成响应结构问题。
 */
function classifyTransportFailure(
  endpoint: string,
  error: unknown,
  timedOut: boolean,
): RemoteModelListResult {
  if (timedOut) {
    return failure(
      "timeout",
      `Request to ${endpoint} timed out after ${REMOTE_MODEL_LIST_TIMEOUT_MS}ms.`,
    );
  }
  const message = isNetworkFailure(error)
    ? `Network request to ${endpoint} failed.`
    : describeError(error);
  return failure("network-error", message);
}

// error 既可能是字符串，也可能是 OpenAI 风格的 { message, type, code } 对象。
const errorEnvelopeSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string().optional() })]).optional(),
  message: z.string().optional(),
  msg: z.string().optional(),
  detail: z.string().optional(),
});

/**
 * 从错误响应体里取出可展示的原因；取不到就退回 `HTTP <status>`。
 * 非 JSON 响应体（常见于网关返回 HTML 错误页）会被截断，避免把整页灌进设置页弹窗。
 */
function readEndpointErrorMessage(rawBody: string, status: number): string {
  const fallback = `HTTP ${status}`;
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return fallback;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return truncateErrorMessage(trimmed, fallback);
  }
  const envelope = errorEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return fallback;
  }
  const { error, message, msg, detail } = envelope.data;
  const nested = typeof error === "string" ? error : error?.message;
  const resolved = (nested ?? message ?? msg ?? detail ?? "").trim();
  return resolved ? truncateErrorMessage(resolved, fallback) : fallback;
}

function truncateErrorMessage(value: string, fallback: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length <= MAX_ERROR_MESSAGE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`;
}
