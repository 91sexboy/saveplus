// Test double for TeleBox `@utils/runtimeManager` client accessor.
import type { TelegramClient } from "teleproto";

let client: TelegramClient | null = null;

export async function getGlobalClient(): Promise<TelegramClient> {
  if (!client) throw new Error("Runtime not initialized");
  return client;
}

export function setGlobalClient(next: TelegramClient | null): void {
  client = next;
}
