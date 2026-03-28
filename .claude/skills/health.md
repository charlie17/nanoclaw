Read the file at `/tmp/laforge-status.json`. If it does not exist, reply: "LaForge status file not found — health monitor may not be running."

Format the status as a concise Telegram-friendly report. Include:
- Overall status (healthy / degraded / unhealthy)
- Timestamp of last check
- Each check result — only flag checks that are not "ok", but list all for completeness
- If overall is unhealthy or degraded, lead with that prominently

Keep it short. No markdown headers — use plain text with bullet points.
Example format:
```
System: healthy (checked 14:32 UTC)
• NanoClaw: ok
• Docker: ok
• RAM: ok (42%)
• Disk: ok (31%)
• Telegram polling: ok
• Zombie containers: ok
```
