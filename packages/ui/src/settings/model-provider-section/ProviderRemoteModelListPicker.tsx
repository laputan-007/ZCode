import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlertIcon, Loader2Icon, RefreshCwIcon } from "lucide-react";
import type {
  RemoteModelListEntry,
  RemoteModelListErrorCode,
  RemoteModelListResult,
} from "@zcode/shared";
import {
  TID_MODEL_PROVIDER_REMOTE_MODELS_ADD_SELECTED_BUTTON,
  TID_MODEL_PROVIDER_REMOTE_MODELS_FETCH_BUTTON,
  TID_MODEL_PROVIDER_REMOTE_MODELS_ITEM,
  TID_MODEL_PROVIDER_REMOTE_MODELS_LIST,
  TID_MODEL_PROVIDER_REMOTE_MODELS_SELECT_ALL,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { ProviderModelMetadataDialogActions } from "@/settings/model-provider-section/ProviderModelMetadataDialogActions.js";

/** 候选列表最多占用的可视高度；超出后由容器滚动，弹窗整体高度不变。 */
const CANDIDATE_LIST_MAX_HEIGHT_CLASS = "max-h-72";

const ERROR_MESSAGE_KEYS: Record<RemoteModelListErrorCode, string> = {
  "base-url-missing": "settings.modelProvider.remoteModels.error.baseUrlMissing",
  "unsupported-access": "settings.modelProvider.remoteModels.error.unsupportedAccess",
  "provider-unavailable": "settings.modelProvider.remoteModels.error.providerUnavailable",
  "capability-unavailable": "settings.modelProvider.remoteModels.error.capabilityUnavailable",
  "http-error": "settings.modelProvider.remoteModels.error.http",
  "invalid-response": "settings.modelProvider.remoteModels.error.invalidResponse",
  "network-error": "settings.modelProvider.remoteModels.error.network",
  timeout: "settings.modelProvider.remoteModels.error.timeout",
};

type PickerPhase =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly endpoint: string;
      readonly models: readonly RemoteModelListEntry[];
    }
  | { readonly status: "error"; readonly message: string };

/**
 * 「获取模型列表」入口：与「添加模型」并列，点击后打开清单对话框并立即拉取。
 *
 * 状态所有者就是本组件：探测结果与勾选集都是 UI 局部状态，不写入任何 store，
 * 关闭弹窗即丢弃；模型落库仍由既有 addPersonalModel 命令承担。
 */
export function ProviderRemoteModelListPicker({
  providerId,
  existingModelIds,
  onFetch,
  onPick,
  disabled = false,
}: {
  providerId: string;
  existingModelIds: readonly string[];
  onFetch: (providerId: string) => Promise<RemoteModelListResult>;
  onPick: (modelIds: string[]) => Promise<void>;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<PickerPhase>({ status: "idle" });
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // 用户连续点击刷新时旧响应可能后到；requestId 守卫保证只有最新一次能写状态。
  const requestIdRef = useRef(0);

  useEffect(() => {
    // 卸载即让在途请求失效，避免对已卸载组件 setState。
    return () => {
      requestIdRef.current += 1;
    };
  }, []);

  const existingIdSet = useMemo(() => new Set(existingModelIds), [existingModelIds]);

  const fetchList = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setPhase({ status: "loading" });
    setSelectedIds([]);
    setSubmitError(null);
    const result = await onFetch(providerId);
    if (requestId !== requestIdRef.current) return;
    if (result.success) {
      setPhase({ status: "ready", endpoint: result.endpoint, models: result.models });
      return;
    }
    logger.warn("[ProviderRemoteModelListPicker] 获取远程模型列表失败", {
      providerId,
      code: result.error.code,
      status: result.error.status,
    });
    setPhase({
      status: "error",
      message: intl.formatMessage(
        { id: ERROR_MESSAGE_KEYS[result.error.code] },
        { detail: result.error.message },
      ),
    });
  }, [intl, onFetch, providerId]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      // 提交中不允许关闭：与「添加模型」弹窗同理，关闭会让旧请求结束掉新草稿。
      if (!next) {
        if (submitting) return;
        setOpen(false);
        return;
      }
      setOpen(true);
      // 按钮语义就是"获取模型列表"，打开即拉取，不要求用户再点一次。
      void fetchList();
    },
    [fetchList, submitting],
  );

  const toggle = useCallback((modelId: string, checked: boolean) => {
    setSelectedIds((current) =>
      checked ? [...current, modelId] : current.filter((id) => id !== modelId),
    );
  }, []);

  // 已存在的模型不可勾选；候选集只在 ready 阶段存在，其余阶段视为空。
  const selectableIds = useMemo(
    () =>
      phase.status === "ready"
        ? phase.models.map((model) => model.id).filter((modelId) => !existingIdSet.has(modelId))
        : [],
    [existingIdSet, phase],
  );
  // 提交只取"既被勾选又仍可添加"的交集：另一条路径刚添加过的模型
  // 不能残留在勾选集里被重复写入。
  const checkedSelectableIds = useMemo(
    () => selectableIds.filter((modelId) => selectedIds.includes(modelId)),
    [selectableIds, selectedIds],
  );
  const allSelected =
    selectableIds.length > 0 && checkedSelectableIds.length === selectableIds.length;
  const partiallySelected = checkedSelectableIds.length > 0 && !allSelected;
  const toggleAll = useCallback(
    (checked: boolean) => {
      setSelectedIds(checked ? [...selectableIds] : []);
    },
    [selectableIds],
  );

  const submit = useCallback(async () => {
    if (checkedSelectableIds.length === 0 || submitting) return;
    const requestId = requestIdRef.current;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onPick(checkedSelectableIds);
      if (requestId !== requestIdRef.current) return;
      setSelectedIds([]);
      setPhase({ status: "idle" });
      setOpen(false);
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      logger.warn("[ProviderRemoteModelListPicker] 批量添加模型失败", error);
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      if (requestId === requestIdRef.current) setSubmitting(false);
    }
  }, [checkedSelectableIds, onPick, submitting]);

  const loading = phase.status === "loading";
  const toggleAllLabel = intl.formatMessage({
    id: allSelected
      ? "settings.modelProvider.remoteModels.clearAll"
      : "settings.modelProvider.remoteModels.selectAll",
  });

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="default"
        className="rounded-lg"
        disabled={disabled}
        data-testid={TID_MODEL_PROVIDER_REMOTE_MODELS_FETCH_BUTTON}
        onClick={() => handleOpenChange(true)}
      >
        <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
        {intl.formatMessage({ id: "settings.modelProvider.remoteModels.fetch" })}
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="max-h-[min(48rem,calc(100vh-4rem))] max-w-xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-clip"
          data-no-model-drag="true"
        >
          <DialogHeader className="pr-8">
            <DialogTitle className="truncate">
              {intl.formatMessage({ id: "settings.modelProvider.remoteModels.title" })}
            </DialogTitle>
            <DialogDescription className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.remoteModels.description" })}
            </DialogDescription>
          </DialogHeader>
          {/* 提交期间锁定正文交互，滚动容器不变；页脚单独显示提交状态。 */}
          <div inert={submitting} className="min-h-0 min-w-0 space-y-3 overflow-y-auto pr-1">
            {loading ? (
              <div
                role="status"
                className="flex h-12 items-center gap-2 rounded-lg border border-dashed border-border px-3 text-ui-base text-foreground-subtle"
              >
                <Loader2Icon className="size-4 shrink-0 animate-spin" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.modelProvider.remoteModels.fetching" })}
              </div>
            ) : null}

            {phase.status === "error" ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
              >
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-ui-sm break-words">{phase.message}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  disabled={submitting}
                  onClick={() => void fetchList()}
                >
                  {intl.formatMessage({ id: "common.retry" })}
                </Button>
              </div>
            ) : null}

            {phase.status === "ready" ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <label
                    className={cn(
                      "flex min-w-0 items-center gap-2 text-ui-base text-foreground-subtle",
                      submitting || selectableIds.length === 0 ? "opacity-60" : "cursor-pointer",
                    )}
                  >
                    <Checkbox
                      disabled={submitting || selectableIds.length === 0}
                      checked={allSelected ? true : partiallySelected ? "indeterminate" : false}
                      onCheckedChange={(checked) => toggleAll(checked === true)}
                      aria-label={toggleAllLabel}
                      data-testid={TID_MODEL_PROVIDER_REMOTE_MODELS_SELECT_ALL}
                    />
                    <span className="shrink-0">{toggleAllLabel}</span>
                  </label>
                  <span className="shrink-0 text-ui-xs text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "settings.modelProvider.remoteModels.selectionCount" },
                      {
                        selected: String(checkedSelectableIds.length),
                        total: String(selectableIds.length),
                      },
                    )}
                  </span>
                </div>
                <div
                  data-testid={TID_MODEL_PROVIDER_REMOTE_MODELS_LIST}
                  className={cn(
                    "overflow-y-auto rounded-lg border border-input-border bg-input",
                    CANDIDATE_LIST_MAX_HEIGHT_CLASS,
                  )}
                >
                  {phase.models.map((model) => {
                    const alreadyAdded = existingIdSet.has(model.id);
                    return (
                      <label
                        key={model.id}
                        data-testid={testId(TID_MODEL_PROVIDER_REMOTE_MODELS_ITEM, model.id)}
                        className={cn(
                          "flex items-center gap-2 border-b border-input-border px-3 py-2 last:border-b-0",
                          alreadyAdded ? "opacity-60" : "cursor-pointer hover:bg-hover",
                        )}
                      >
                        <Checkbox
                          disabled={submitting || alreadyAdded}
                          checked={selectedIds.includes(model.id)}
                          onCheckedChange={(checked) => toggle(model.id, checked === true)}
                          aria-label={model.id}
                        />
                        <span className="min-w-0 flex-1 truncate font-mono text-ui-base text-foreground">
                          {model.id}
                        </span>
                        {alreadyAdded ? (
                          <span className="shrink-0 text-ui-xs text-foreground-subtlest">
                            {intl.formatMessage({
                              id: "settings.modelProvider.remoteModels.alreadyAdded",
                            })}
                          </span>
                        ) : null}
                      </label>
                    );
                  })}
                </div>
                <p className="truncate text-ui-xs text-foreground-subtlest" title={phase.endpoint}>
                  {phase.endpoint}
                </p>
              </>
            ) : null}

            {submitError ? (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
              >
                <CircleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 text-ui-sm break-words">{submitError}</span>
              </div>
            ) : null}
          </div>
          <ProviderModelMetadataDialogActions
            cancelLabel={intl.formatMessage({ id: "common.cancel" })}
            saveLabel={intl.formatMessage(
              { id: "settings.modelProvider.remoteModels.addSelected" },
              { count: checkedSelectableIds.length },
            )}
            saving={submitting}
            saveDisabled={loading || checkedSelectableIds.length === 0}
            saveTestId={TID_MODEL_PROVIDER_REMOTE_MODELS_ADD_SELECTED_BUTTON}
            onSave={() => void submit()}
            onCancel={() => handleOpenChange(false)}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
