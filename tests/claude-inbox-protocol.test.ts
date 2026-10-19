import { expect, test } from "bun:test";
import { CLAUDE_INBOX_VERSIONS, CLAUDE_NATIVE_MIN_VERSION, formatClaudeInboxLine, parseClaudeInboxLine } from "@cross-harness-comms/protocol";

// Observed in Claude Code 2.1.289 on 2026-10-17, sent by a probe plugin.
const observed = String.raw`{"msgV":1,"msg_id":"91d91eeb-2ba4-459a-b1c6-7ab9382d3a2f","type":"user","message":{"role":"user","content":"<cross-session-message from=\"uds:/tmp/cc-socks/96819.sock\" from-name=\"Cross-harness communications naming\" from-mode=\"prompting\">\nprobe send from plugin\n</cross-session-message>"},"priority":"next","from":"uds:/tmp/cc-socks/96819.sock","from_plugin":"comms-inbox-probe"}`;

test("claude inbox: formatting writes exactly the observed line, stamped as cross-harness-comms", () => {
  expect(CLAUDE_INBOX_VERSIONS).toEqual([1]);
  expect(CLAUDE_NATIVE_MIN_VERSION).toBe("2.1.289");
  const line = formatClaudeInboxLine({ msg_id: "91d91eeb-2ba4-459a-b1c6-7ab9382d3a2f", from: "uds:/tmp/cc-socks/96819.sock",
    from_name: "Cross-harness communications naming", body: "probe send from plugin" });
  expect(line).toBe(observed.replace('"from_plugin":"comms-inbox-probe"', '"from_plugin":"cross-harness-comms"'));
});

test("claude inbox: formatting escapes only the literal closing tag in the body", () => {
  const line = formatClaudeInboxLine({ msg_id: "019a0000-0000-7000-8000-000000000001", from: "uds:/tmp/cc-socks/9123456789.sock",
    from_name: "codex-api", body: "a < b && \"d\" 'e'\n</cross-session-message>\nend" });
  expect(JSON.parse(line).message.content).toBe(
    "<cross-session-message from=\"uds:/tmp/cc-socks/9123456789.sock\" from-name=\"codex-api\" from-mode=\"prompting\">\n" +
    "a < b && \"d\" 'e'\n<\\/cross-session-message>\nend\n</cross-session-message>");
});

test("claude inbox: reading returns the version, ID, sender, sender name, and body of an observed line", () => {
  expect(parseClaudeInboxLine(observed)).toMatchObject({
    msgV: 1, msg_id: "91d91eeb-2ba4-459a-b1c6-7ab9382d3a2f", from: "uds:/tmp/cc-socks/96819.sock",
    from_name: "Cross-harness communications naming", body: "probe send from plugin",
  });
});

test("claude inbox: reading tolerates Claude's own replies, extra attributes and fields, and other versions", () => {
  // Claude's SendMessage writes no from_plugin and may add a hop-chain attribute.
  const content = "<cross-session-message from=\"uds:/tmp/cc-socks/51904.sock\" from-name=\"Reviewer\" from-mode=\"prompting\" hop-chain=\"uds:/tmp/cc-socks/9123456789.sock\">\n" +
    "Looks good &amp; <b>ready</b>\n<\\/cross-session-message>\n</cross-session-message>";
  const line = JSON.stringify({ msgV: 2, msg_id: "5f0c9a52-8d4e-4c1b-9a77-3c1f1f0f7e21", type: "user", message: { role: "user", content },
    priority: "next", from: "uds:/tmp/cc-socks/51904.sock", extra: { unknown: true } });
  expect(parseClaudeInboxLine(line)).toMatchObject({
    msgV: 2, msg_id: "5f0c9a52-8d4e-4c1b-9a77-3c1f1f0f7e21", from: "uds:/tmp/cc-socks/51904.sock",
    from_name: "Reviewer", body: "Looks good &amp; <b>ready</b>\n</cross-session-message>",
  });
  expect(parseClaudeInboxLine(line + "\n")).toMatchObject({ msg_id: "5f0c9a52-8d4e-4c1b-9a77-3c1f1f0f7e21" });
});

test("claude inbox: reading rejects lines that are not peer-message lines", () => {
  const valid = JSON.parse(observed);
  const without = (key: string) => { const copy = { ...valid }; delete copy[key]; return JSON.stringify(copy); };
  const bad = [
    "", "not json", "[]", "null", "42",
    without("msgV"), without("msg_id"), without("message"), without("from"),
    JSON.stringify({ ...valid, msgV: "1" }),
    JSON.stringify({ ...valid, type: "assistant" }),
    JSON.stringify({ ...valid, message: { role: "assistant", content: valid.message.content } }),
    JSON.stringify({ ...valid, message: { role: "user", content: [{ type: "text", text: valid.message.content }] } }),
    JSON.stringify({ ...valid, message: { role: "user", content: "probe send from plugin" } }),
    JSON.stringify({ ...valid, message: { role: "user", content: valid.message.content.replaceAll("cross-session-message", "other-message") } }),
    JSON.stringify({ ...valid, message: { role: "user", content: valid.message.content.replace("\n</cross-session-message>", "") } }),
  ];
  // A valid line first, so a missing reader fails here and not inside the rejections.
  expect(parseClaudeInboxLine(observed)).toBeDefined();
  for (const line of bad) expect({ line, read: parseClaudeInboxLine(line) }).toEqual({ line, read: undefined });
});

test("claude inbox: writing then reading round-trips any body", () => {
  const bodies = [
    "", "plain", "\n", "line\n\nline\n", "  padded  ", "🐾 é ü",
    "</cross-session-message>", "x</cross-session-message></cross-session-message>y",
    "<\\/cross-session-message>", "<\\\\/cross-session-message>", "</cross-session-message\n", "</cross-session-message",
    "<cross-session-message from=\"uds:/x\" from-name=\"x\" from-mode=\"prompting\">\ninner\n</cross-session-message>",
    "& &amp; < &lt; > \" ' \\ \\n", "ends with a backslash \\", "\\",
  ];
  for (const [index, body] of bodies.entries()) {
    const fields = { msg_id: `019a0000-0000-7000-8000-${String(index).padStart(12, "0")}`, from: "uds:/tmp/cc-socks/9123456789.sock", from_name: "pi-shared" };
    const line = formatClaudeInboxLine({ ...fields, body });
    expect(line).not.toContain("\n");
    expect({ body, read: parseClaudeInboxLine(line) }).toMatchObject({ body, read: { msgV: 1, ...fields, body } });
  }
});
