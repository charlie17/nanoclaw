The user wants to set a reminder. A reminder is a scheduled task that sends a Telegram message at the specified time.

## Step 1 — Parse the request

Extract from the message:
- **When:** date, time, and recurrence pattern
- **What:** the reminder text (verbatim from JT's message)

If either is ambiguous, ask a clarifying question before proceeding. Do not guess.

**Date/time interpretation rules:**
- All times are LOCAL (use JT's timezone from system context, not UTC)
- "Tomorrow at 9am" → compute the ISO date for tomorrow at 09:00 local
- "4/21" with no year → use the next occurrence of that date
- "In 5 minutes" → compute now + 5 minutes
- "Every Friday at 10am" → cron pattern

## Step 2 — Map to schedule type

| Request pattern | schedule_type | schedule_value |
|---|---|---|
| Specific date/time, runs once | `once` | `"2026-04-21T10:00:00"` — local time, **no Z suffix** |
| Every N minutes/hours | `interval` | milliseconds, e.g. `"300000"` for 5 min |
| Weekly, daily, or at specific time patterns | `cron` | standard cron expression (local time) |

Common cron patterns:
- Daily at 9am: `0 9 * * *`
- Weekdays at 8am: `0 8 * * 1-5`
- Every Friday at 10am: `0 10 * * 5`
- Weekly on Mondays at 9am: `0 9 * * 1`

## Step 3 — Build the task prompt

The task prompt is what the agent runs when the reminder fires. For reminders:

```
Send this reminder to JT via Telegram: "{verbatim reminder text}"
```

Keep it simple and verbatim. The agent's only job is to send the message.

## Step 4 — Schedule the task

Call `mcp__nanoclaw__schedule_task` with:
- `prompt`: the task prompt from Step 3
- `schedule_type`: from Step 2
- `schedule_value`: from Step 2
- `context_mode`: `isolated` (reminders are self-contained — no conversation context needed)

## Step 5 — Confirm

Reply with:
- What you'll remind JT about
- When (human-readable: "Tuesday, April 21 at 10:00 AM")
- For recurring reminders: the recurrence pattern in plain English
- Task ID (for cancellation if needed)

Example: "Set. I'll remind you to call the dentist on Tuesday, April 21 at 10:00 AM."
