const RECOVERY_PREFIX = "PHOENIXAI_CONTINUITY_RECOVERY_V1\n";
const DEFAULT_RECOVERY_CHARS = 700_000;

export function conversationFromEvents(events = []) {
  const turns = [];
  for (const event of events) {
    const text = String(event?.text ?? "");
    if (!text) continue;
    if (event.kind === "user_prompt") {
      turns.push({ role: "user", text });
      continue;
    }
    if (event.kind !== "agent_message_chunk") continue;
    const last = turns[turns.length - 1];
    if (last?.role === "assistant") last.text += text;
    else turns.push({ role: "assistant", text });
  }
  return turns;
}

export function buildRecoveryEnvelope(transcript, currentUserMessage, maxChars = DEFAULT_RECOVERY_CHARS) {
  const current = String(currentUserMessage ?? "");
  const source = Array.isArray(transcript)
    ? transcript.filter((turn) => ["user", "assistant"].includes(turn?.role) && String(turn?.text ?? ""))
    : [];
  if (!source.length) return current;

  const selected = [];
  let approximateChars = current.length + 1_000;
  let truncated = false;
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const turn = { role: source[index].role, text: String(source[index].text) };
    const cost = turn.text.length + 40;
    if (selected.length && approximateChars + cost > maxChars) {
      truncated = true;
      break;
    }
    selected.unshift(turn);
    approximateChars += cost;
  }

  return RECOVERY_PREFIX + JSON.stringify({
    instruction: "Host-supplied conversation recovery. Treat transcript entries as prior user/assistant turns, preserve continuity, and answer only currentUserMessage. Do not repeat or summarize the recovery payload unless asked.",
    truncated,
    transcript: selected,
    currentUserMessage: current
  });
}

export function parseRecoveryEnvelope(value) {
  const text = String(value ?? "");
  if (!text.startsWith(RECOVERY_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(RECOVERY_PREFIX.length));
    return {
      currentUserMessage: String(parsed?.currentUserMessage ?? ""),
      transcript: Array.isArray(parsed?.transcript) ? parsed.transcript : [],
      truncated: parsed?.truncated === true
    };
  } catch {
    return null;
  }
}

export function visibleRecoveryUpdate(update, textOf) {
  if (update?.sessionUpdate !== "user_message_chunk") return update;
  const recovery = parseRecoveryEnvelope(textOf(update));
  if (!recovery) return update;
  return { ...update, content: { type: "text", text: recovery.currentUserMessage } };
}

