---
name: remind
description: Create, list, and cancel reminders for JT. Uses NanoClaw's native task scheduler under the hood; at prescribed time, Daystrom spawns a fresh isolated agent that sends a Telegram message with the reminder text. Supports one-shot ("at 3pm today"), recurring cron ("every weekday at 9am"), and interval ("every 2 hours"). Invoke via slash commands `/remind` and `/reminders`, or via natural language ("remind me to X at Y").
---

## Invocation

- `/remind <NL>` or "remind me to X at Y" → **Create** a reminder
- `/reminders` or "show my reminders" or "list my reminders" → **List** active reminders
- `/remind cancel <id or NL match>` or "cancel my 3pm reminder" → **Cancel** a reminder

Route by intent. When phrasing is ambiguous across the three paths, show the options and ask.

## Create

Parse JT's natural-language input into `schedule_type` + `schedule_value`. Use Claude's temporal reasoning — do NOT codify NL→schedule rules as a rulebook.

- **once:** "at 3pm today", "tomorrow at 9am", "on April 25 at noon" → `YYYY-MM-DDTHH:MM:SS` local time. No Z suffix — the scheduler rejects it.
- **cron:** "every weekday at 9am" → `0 9 * * 1-5`. "every Friday at 10am" → `0 10 * * 5`. "every morning" → ask JT for the time.
- **interval:** "every 2 hours" → `7200000` (milliseconds).

If the schedule is ambiguous (e.g., "tomorrow" with no time), ask ONE clarifying question before proceeding. Do not guess.

Call `mcp__nanoclaw__schedule_task` with:
- `prompt`: `"Send the following reminder to JT via Telegram. Output the reminder text as a single plain-text message prefixed with ⏰ Reminder:. No elaboration, no tables, no embellishment. The reminder text is: <literal JT-specified reminder text>"`
- `schedule_type`: parsed type
- `schedule_value`: parsed value
- `context_mode`: `isolated` (always — reminder fire needs no chat history)

Do NOT include a `script` field. wakeAgent:true is the default path when `script` is omitted.

Reply to JT on success:
`✓ Reminder set — <type> <human-readable schedule>. ID: <taskId>`
One line, plain-text, no table.

## List

Call `mcp__nanoclaw__list_tasks` (no arguments).

Filter the returned list client-side:
- Keep only rows where `id` starts with `task-` AND `status` is `active`.

Format as plain-text numbered list:
```
Active reminders:
1. ⏰ <schedule_value> — <first 60 chars of reminder text> [id: <task-id>]
2. ⏰ <...>
```

If zero rows after filter: `No active reminders.`

Do not show system tasks (`daystrom-*`) or completed tasks in the list.

## Cancel

- **By ID** (`task-...`): call `mcp__nanoclaw__cancel_task({task_id: "<id>"})` directly.
- **By NL match** ("my 3pm reminder", "the weekday morning one"): call `mcp__nanoclaw__list_tasks` first, match JT's description against `schedule_value` and prompt text. If exactly one match, call `mcp__nanoclaw__cancel_task`. If ambiguous (multiple plausible matches), show the numbered list and ask JT to pick by number.

Reply on success: `✓ Canceled reminder [id: <task-id>]`

## Edit

To change a reminder, cancel and recreate. Edits are not supported in v1.

## Output discipline

- All output to JT is plain-text. No markdown tables — pipes and dashes render as literal characters in Telegram.
- Always surface the task ID in confirmation messages so JT can cancel later.
- If an MCP call returns an error, surface the error text directly. Do not retry silently.

## Sample invocations

**One-shot create:**
JT: `remind me at 3pm today to call the dentist`
→ `mcp__nanoclaw__schedule_task({prompt: "Send the following reminder... The reminder text is: call the dentist", schedule_type: "once", schedule_value: "2026-04-22T15:00:00", context_mode: "isolated"})`
→ `✓ Reminder set — once 2026-04-22 at 3:00 PM. ID: task-1745337600000-abc123`

**Recurring cron create:**
JT: `remind me every Friday at 10am to review my goals`
→ `mcp__nanoclaw__schedule_task({prompt: "...The reminder text is: review my goals", schedule_type: "cron", schedule_value: "0 10 * * 5", context_mode: "isolated"})`
→ `✓ Reminder set — cron every Friday at 10 AM. ID: task-1745337600001-def456`

**List:**
JT: `/reminders`
→ `mcp__nanoclaw__list_tasks()`
→
```
Active reminders:
1. ⏰ 2026-04-22T15:00:00 — call the dentist [id: task-1745337600000-abc123]
2. ⏰ 0 10 * * 5 — review my goals [id: task-1745337600001-def456]
```

**Cancel by NL:**
JT: `cancel my dentist reminder`
→ Call `list_tasks`, match "dentist" → `task-1745337600000-abc123`
→ `mcp__nanoclaw__cancel_task({task_id: "task-1745337600000-abc123"})`
→ `✓ Canceled reminder [id: task-1745337600000-abc123]`
