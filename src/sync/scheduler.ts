/**
 * 定时同步调度器只负责重试节奏和停止语义，不了解 WebDAV/S3 或知识内容。
 *
 * 采用前台长进程而不是自动写 cron/launchd，避免安装命令未经用户确认创建系统级任务。
 * 调用方可用 systemd、launchd、容器或进程管理器托管 `agent-knowledge sync watch`。
 */
export async function runScheduledSync(options: {
  intervalMinutes: number;
  signal: AbortSignal;
  run: () => Promise<void>;
  onError?: (error: Error) => void;
}): Promise<void> {
  if (!Number.isFinite(options.intervalMinutes) || options.intervalMinutes <= 0) {
    throw new Error("Scheduled sync interval must be a positive number of minutes");
  }

  const intervalMs = options.intervalMinutes * 60_000;
  while (!options.signal.aborted) {
    try {
      await options.run();
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
    if (options.signal.aborted) {
      return;
    }
    await waitForNextRun(intervalMs, options.signal);
  }
}

/** 等待下一周期；AbortSignal 会清理 timer 并立即结束，支持进程优雅停止。 */
function waitForNextRun(intervalMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, intervalMs);
    const stop = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}
