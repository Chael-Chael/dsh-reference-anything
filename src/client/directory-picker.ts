export interface DirectoryPicker {
  pickDirectory(): Promise<string | null>
}

/** Bridge the Host picker into the settings error channel without rejecting UI event handlers. */
export async function pickDirectoryWithError(
  picker: DirectoryPicker,
  reportError: (error: unknown) => void,
): Promise<string | null> {
  try { return await picker.pickDirectory() }
  catch (error) { reportError(error); return null }
}
