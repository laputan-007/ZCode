/* eslint-disable max-lines -- 模型供应商 schema、迁移和运行时投影 helper 需要共享同一套类型边界，暂时集中在单文件避免契约分散。 */
export const BUILTIN_PROVIDER_TEMPLATE_IDS = {
  zai: "zai-api",
  bigmodel: "bigmodel-api",
} as const;

export const BUILTIN_MODEL_PROVIDER_IDS = {
  zaiIndividualCodingPlan: "account:zai-individual-coding-plan",
  zaiTeamCodingPlan: "account:zai-team-coding-plan",
  zaiStartPlan: "account:zai-start-plan",
  bigmodelIndividualCodingPlan: "account:bigmodel-individual-coding-plan",
  bigmodelTeamCodingPlan: "account:bigmodel-team-coding-plan",
  bigmodelStartPlan: "account:bigmodel-start-plan",
} as const;

export type BuiltinOAuthProviderId = keyof typeof BUILTIN_MODEL_PROVIDER_IDS;

export type BuiltinModelProviderId = (typeof BUILTIN_MODEL_PROVIDER_IDS)[BuiltinOAuthProviderId];

export function isBuiltinModelProviderId(id: string): id is BuiltinModelProviderId {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

export function isZaiCodingPlanProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  );
}

export function isBigModelStartPlanProviderId(id: string): boolean {
  return id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
}

export function isStartPlanModelProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

/**
 * 个人版 Coding Plan（不含 Start Plan 与 Team Plan）。
 * Start Plan 用 disconnected 展示领取/付费卡，Team Plan 有独立文案，
 * "服务端明确无权益"只对个人版需要区分成"未开通"。
 */
export function isIndividualCodingPlanModelProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  );
}

export function isCodingPlanModelProviderId(id: string): boolean {
  return (
    isZaiCodingPlanProviderId(id) ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

/** 一个正式 Model 的连通性测试结果。 */
export type ModelConnectivityResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: {
        readonly message: string;
        /** 设置连接测试边界已确认的资格失败；其他执行错误保留原消息。 */
        readonly code?: "provider-unavailable" | "model-unavailable";
      };
    };

/** 远程模型清单里的一条候选。只保留 `/v1/models` 实际返回的展示性字段。 */
export interface RemoteModelListEntry {
  readonly id: string;
  readonly ownedBy?: string;
  readonly created?: number;
}

/**
 * 远程模型清单探测的失败归因。
 * 结构化 code 供 UI 映射本地化文案；不依赖 message 文本做流程判断。
 */
export type RemoteModelListErrorCode =
  /** Effective Config 没有可用 Base URL，或无法解析成 http(s) 端点。 */
  | "base-url-missing"
  /** 账号类 Provider 没有用户可填的 Key，不猜凭证。 */
  | "unsupported-access"
  /** Provider 不存在、已停用，或 API 协议类型尚未配置完整。 */
  | "provider-unavailable"
  /** 当前 Environment 未装配探测能力，或远程 Environment 版本较旧没有该方法。 */
  | "capability-unavailable"
  | "http-error"
  | "invalid-response"
  | "network-error"
  | "timeout";

/** 一次远程模型清单探测的结果。失败也走结构化返回，不向 Renderer 抛异常。 */
export type RemoteModelListResult =
  | {
      readonly success: true;
      /** 实际请求的端点，供 UI 展示"从哪个地址取到的"。 */
      readonly endpoint: string;
      readonly models: readonly RemoteModelListEntry[];
    }
  | {
      readonly success: false;
      readonly error: {
        readonly message: string;
        readonly code: RemoteModelListErrorCode;
        readonly status?: number;
      };
    };
