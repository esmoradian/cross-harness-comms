// The text Codex, and Claude on the comms fallback route, receive for an incoming message.
// `name` is the sender's comms name, its address without `comms:`.

export function expectedCodexText(fields: { name: string; id: string; body: string; reply_to?: string | null }): string {
  const replies = fields.reply_to ? ` This replies to ${fields.reply_to}.` : "";
  return `Message from @${fields.name} (another agent, through comms):\n${fields.body}\n\n`
    + `Reply with comms_send to comms:${fields.name} with reply_to ${fields.id}.${replies}`;
}

// Claude's adapter fills in reply_to itself, so the hint names only the address.
export function expectedClaudeText(fields: { name: string; body: string; reply_to?: string | null }): string {
  const replies = fields.reply_to ? ` This replies to ${fields.reply_to}.` : "";
  return `Message from @${fields.name} (another agent, through comms):\n${fields.body}\n\n`
    + `Reply with SendMessage to comms:${fields.name}.${replies}`;
}

export const SENDER_HEADER = /^Message from @[a-z0-9._/-]+ \(another agent, through comms\):\n/;
