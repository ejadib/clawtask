// The keyboard behavior belongs to the real browser host, not its emulated viewport/UA.
export function scrollToBottomKey(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End';
}
