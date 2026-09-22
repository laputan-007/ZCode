import { useCallback, useMemo, useState } from "react";
import { Cable, ChevronDown, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { McpStatusDot } from "@/settings/McpServerList.js";
import { resolveMcpFailureMessageId } from "@/settings/McpFailurePresentation.js";
import { useMcpStore } from "@/store/mcpStore.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import type { McpServerStatus, ZCodeMcpServer } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";

interface ComposerMcpSelectorProps {
  workspacePath: string;
  workspaceIdentity?: string;
}

function resolveStatusReason(
  server: ZCodeMcpServer,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
): string {
  if (server.status === "error") {
    return intl.formatMessage({
      id: resolveMcpFailureMessageId(server.failureKind),
    });
  }
  if (server.status === "connected") {
    return intl.formatMessage({ id: "settings.mcp.status.connectedReason" });
  }
  if (server.status === "connecting") {
    return intl.formatMessage({ id: "settings.mcp.status.connectingReason" });
  }
  if (server.status === "disconnected") {
    return intl.formatMessage({ id: "settings.mcp.status.disconnectedReason" });
  }
  return intl.formatMessage({ id: "settings.mcp.status.unknownReason" });
}

/** 已启用优先、connected 靠前，其余按名称稳定排序，保证 chip 与下拉顺序一致。 */
function sortServersForDisplay(servers: readonly ZCodeMcpServer[]): ZCodeMcpServer[] {
  const statusRank: Record<McpServerStatus, number> = {
    connected: 0,
    connecting: 1,
    error: 2,
    disconnected: 3,
    unknown: 4,
  };
  return servers.slice().sort((left, right) => {
    const enabledDelta = Number(right.enabled) - Number(left.enabled);
    if (enabledDelta !== 0) return enabledDelta;
    const rankDelta = statusRank[left.status ?? "unknown"] - statusRank[right.status ?? "unknown"];
    if (rankDelta !== 0) return rankDelta;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}

/**
 * 输入框外的 MCP 快捷条。
 *
 * 启用/禁用状态的唯一所有者是 mcpStore（toggleServer 落盘到用户目录配置，Agent 从磁盘读取），
 * 本组件只读投影 + 转发命令，不维护第二份选择状态。
 *
 * 状态刷新同样不另建所有者：走 store 的 epoch 原语（begin / merge / markFailed），
 * 与 MCP 设置页共用同一套并发与迟到结果仲裁。
 */
export function ComposerMcpSelector({
  workspacePath,
  workspaceIdentity,
}: ComposerMcpSelectorProps) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const mcpSyncService = services?.mcpSyncService;
  const currentProjectPath = useMcpStore((s) => s.currentProjectPath);
  const currentWorkspaceIdentity = useMcpStore((s) => s.currentWorkspaceIdentity);
  const isConfigLoaded = useMcpStore((s) => s.isConfigLoaded);
  const servers = useMcpStore((s) => s.servers);
  const toggleServer = useMcpStore((s) => s.toggleServer);
  const updateServerStatus = useMcpStore((s) => s.updateServerStatus);
  const beginServerStatusListRefresh = useMcpStore((s) => s.beginServerStatusListRefresh);
  const mergeServerStatusSnapshots = useMcpStore((s) => s.mergeServerStatusSnapshots);
  const markServerStatusListRefreshFailed = useMcpStore((s) => s.markServerStatusListRefreshFailed);
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // active tab 会先于异步 MCP 目录加载切换；过渡帧不能把 A 的配置投影到 B 的 composer。
  const activeWorkspaceKey = workspaceIdentity?.trim() || workspacePath;
  const storeWorkspaceKey = currentWorkspaceIdentity?.trim() || currentProjectPath;
  const storeMatchesWorkspace =
    Boolean(activeWorkspaceKey) && storeWorkspaceKey === activeWorkspaceKey;

  const candidateServers = useMemo(() => {
    if (!storeMatchesWorkspace || !isConfigLoaded) return [];
    return sortServersForDisplay(servers.filter((server) => server.source === "zcodeagentmcp"));
  }, [isConfigLoaded, servers, storeMatchesWorkspace]);

  const enabledServers = useMemo(
    () => candidateServers.filter((server) => server.enabled),
    [candidateServers],
  );

  /**
   * 开启后必须由本组件把 connecting 收敛成真实状态。
   *
   * 原因：mergeServerStatusSnapshots 的唯一其它调用方是 MCP 设置页，设置页没挂载时
   * 没有任何人收敛 connecting，状态点会永久转圈（用户实测到的「一直 Loading」）。
   */
  const refreshServerStatuses = useCallback(async (): Promise<void> => {
    if (!mcpSyncService || !workspacePath) return;
    const requestedWorkspaceKey = activeWorkspaceKey;
    const requestEpoch = beginServerStatusListRefresh("connect");
    try {
      const result = await mcpSyncService.listWorkspaceMcpServerStatuses({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        // agent 侧 mcp/list 自己 createConfig 读不到 UI-resolved 配置，必须显式下发（同设置页）。
        mcpServers: useMcpStore.getState().getEnabledMcpServersForZCode("zcode"),
      });
      const state = useMcpStore.getState();
      const latestWorkspaceKey = state.currentWorkspaceIdentity?.trim() || state.currentProjectPath;
      if (latestWorkspaceKey !== requestedWorkspaceKey) {
        // 请求期间已切 workspace；旧结果含 env/header 等配置，不能写回共享 store。
        logger.debug("[composer-mcp] 丢弃跨 workspace 的状态刷新结果", {
          requestedWorkspaceKey,
          latestWorkspaceKey,
        });
        return;
      }
      mergeServerStatusSnapshots(result.statuses, requestEpoch, "connect");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("[composer-mcp] 刷新 MCP 状态失败", { message, workspacePath });
      // 失败也要收敛：markFailed 会把仍处于 connecting 的项落成 error，
      // 否则同样留下永久转圈。
      markServerStatusListRefreshFailed(message, requestEpoch, "connect");
    }
  }, [
    activeWorkspaceKey,
    beginServerStatusListRefresh,
    markServerStatusListRefreshFailed,
    mcpSyncService,
    mergeServerStatusSnapshots,
    workspaceIdentity,
    workspacePath,
  ]);

  const handleToggle = useCallback(
    async (server: ZCodeMcpServer, enabled: boolean) => {
      if (togglingId !== null) return;
      setTogglingId(server.id);
      let shouldRefresh = false;
      try {
        await toggleServer(server.id, enabled);
        if (!enabled) {
          // 禁用后的 unknown 只是本地展示态；toggleServer 已作废旧请求，
          // 这里不能再推进 epoch，否则刚返回的 mcp/list 会被丢弃并造成反复转圈。
          updateServerStatus(server.id, "unknown", undefined, {
            invalidateStatusListRequests: false,
          });
        } else {
          // 只有确实发得出刷新时才写 connecting；拿不到 mcpSyncService 时宁可停在
          // unknown（灰点），也不能写一个没人收敛的转圈态。
          shouldRefresh = mcpSyncService !== undefined && workspacePath.length > 0;
          updateServerStatus(server.id, shouldRefresh ? "connecting" : "unknown", undefined, {
            invalidateStatusListRequests: false,
          });
        }
      } finally {
        setTogglingId(null);
      }
      // 刷新不阻塞菜单：mcp/list 会等所有 MCP 连完（插件 MCP 超时时可达数十秒），
      // 期间用户仍应能继续开关其它项；并发与迟到结果由 store 的 epoch 仲裁。
      if (shouldRefresh) void refreshServerStatuses();
    },
    [
      mcpSyncService,
      refreshServerStatuses,
      toggleServer,
      togglingId,
      updateServerStatus,
      workspacePath,
    ],
  );

  const openMcpSettings = useCallback(() => {
    // 只写 pending intent 不够：设置页未打开时没有订阅者消费它，点击会看起来毫无反应。
    // 与工具条「管理模型」入口同一路径——先落意图，再打开设置页 tab。
    setPendingSettingsSectionIntent("mcp");
    openSettingsTab();
  }, [openSettingsTab]);

  if (candidateServers.length === 0) {
    return null;
  }

  // 已安装可能很多个：输入框外只常驻一个，其余折叠成 +N，完整开关都在下拉里。
  const [primaryServer, ...overflowServers] = enabledServers;
  const manageLabel = intl.formatMessage({ id: "chat.composer.mcp.manage" });

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5 px-1.5 pt-1.5"
      data-composer-mcp-selector="true"
    >
      {primaryServer ? (
        <div
          className={cn(
            "flex min-w-0 max-w-[14rem] items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-ui-sm text-foreground",
            primaryServer.status === "error" && "border-destructive/30",
          )}
          data-mcp-server-name={primaryServer.name}
          data-mcp-status={primaryServer.status ?? "unknown"}
        >
          <Cable className="size-3.5 shrink-0 text-foreground-subtle" aria-hidden="true" />
          <span className="truncate">{primaryServer.name}</span>
          {/* 状态详情由 McpStatusDot 自带 tooltip 承载，chip 外层不再套一层，避免嵌套覆盖。 */}
          <McpStatusDot
            status={primaryServer.status}
            reason={resolveStatusReason(primaryServer, intl)}
          />
        </div>
      ) : (
        <span className="px-1 text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "chat.composer.mcp.noneEnabled" })}
        </span>
      )}
      {overflowServers.length > 0 ? (
        <ControlHintTooltip title={overflowServers.map((server) => server.name).join("、")}>
          <span
            className="shrink-0 rounded-md bg-surface px-1.5 py-1 text-ui-xs text-foreground-subtle ring-1 ring-border"
            aria-label={intl.formatMessage(
              { id: "chat.composer.mcp.moreCount" },
              { count: String(overflowServers.length) },
            )}
          >
            +{overflowServers.length}
          </span>
        </ControlHintTooltip>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={manageLabel}
            title={manageLabel}
            className="shrink-0 text-foreground-subtle hover:text-foreground"
          >
            <ChevronDown className="size-3.5" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 w-64 overflow-y-auto">
          <DropdownMenuLabel className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.composer.mcp.toggleGroup" })}
          </DropdownMenuLabel>
          {candidateServers.map((server) => (
            <DropdownMenuCheckboxItem
              key={server.id}
              checked={server.enabled}
              disabled={togglingId !== null}
              data-mcp-toggle-name={server.name}
              // 连续开关多个 MCP 是常态；阻止 Radix 选中即关闭，让用户留在菜单里。
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => void handleToggle(server, Boolean(checked))}
            >
              <McpStatusDot
                status={server.status}
                reason={resolveStatusReason(server, intl)}
                disabled={!server.enabled}
              />
              <span
                className={cn("truncate", !server.enabled && "text-foreground-subtle")}
                title={server.name}
              >
                {server.name}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem className="flex items-center gap-2" onSelect={openMcpSettings}>
            <Settings2 className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "chat.composer.mcp.openSettings" })}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
