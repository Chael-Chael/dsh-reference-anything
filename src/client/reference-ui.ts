/**
 * Apply the persisted @-UI switch before reloading the whole DSH Web shell.
 *
 * Keeping the reload after the awaited action is important: a rejected RPC
 * must leave the current page in place so its error remains visible.
 */
export async function runReferenceUiSwitchWithReload(
  action: () => Promise<void>,
  reload: () => void = () => { window.location.reload() },
): Promise<void> {
  await action()
  reload()
}
