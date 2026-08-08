/**
 * Edit commands the model emits for the server to execute. They are machine
 * instructions, not prose, so they are removed before the message is rendered.
 *
 * The trailing `|$` also matches a block that is still streaming in — without it
 * a half-written command flashes its JSON payload into the transcript until the
 * closing marker arrives.
 */
const EDIT_COMMAND_RE =
  /:::(?:EDIT_PAGE|UPDATE_TITLE):::[\s\S]*?(?::::(?:END_EDIT|END_TITLE):::|$)/g;

export function stripEditCommands(text?: string | null): string {
  if (!text) return "";
  return text.replace(EDIT_COMMAND_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}
