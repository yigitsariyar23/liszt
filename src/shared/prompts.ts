// Telling the prompts the user typed apart from what Claude Code adds to user turns itself, so the
// chat draws one bubble per prompt and a rewind finds the same prompt in the transcript.

/** Claude Code's own markup at the start of a user turn: commands, their output, reminders, `!` commands. */
export const META = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr)>/;

type Block = { type: string; text?: unknown };

/** The text of a user turn the user typed, or null for tool results and Claude Code's own additions. */
export function promptText(content: unknown): string | null {
  const blocks: Block[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Block[]) : [];
  if (blocks.some((b) => b.type === 'tool_result')) return null;
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => String(b.text))
    .join('\n\n');
  if (META.test(text)) return null;
  // An image alone is a prompt too.
  return text || blocks.some((b) => b.type === 'image') ? text : null;
}
