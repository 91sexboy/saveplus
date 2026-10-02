// Test double for TeleBox `@utils/pluginManager` prefix accessors.
let prefixes = [".", "。", "$"];

export function getPrefixes(): string[] {
  return prefixes;
}

export function setPrefixes(next: string[]): void {
  prefixes = next;
}
