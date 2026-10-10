import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Invokes a command that streams back while it runs over a Tauri channel, passed as the
 * command's `logs` argument (log lines) or `events` argument (test steps, terminal output).
 */
export function invokeStreaming<M, R = void>(
  command: string,
  args: Record<string, unknown>,
  onMessage: (message: M) => void,
  channel: "logs" | "events" = "logs",
) {
  const stream = new Channel<M>();
  stream.onmessage = onMessage;
  return invoke<R>(command, { ...args, [channel]: stream });
}
