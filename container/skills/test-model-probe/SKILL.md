---
name: /test-model-probe
description: Diagnostic probe — reports current model ID to file. DELETE AFTER USE.
model: claude-opus-4-7
---

This is a diagnostic probe. Your ONLY task:

1. Run this Bash command and capture the output:
   `env | grep -E 'ANTHROPIC_MODEL|CLAUDE_CODE_MODEL|CLAUDE_MODEL|ANTHROPIC_API' | grep -v 'KEY\|TOKEN'`

2. Write the following to /workspace/extra/vault/tmp/model-probe.txt (create the tmp/ dir if needed):
   - Line 1: `ENV_VARS: <output from step 1, or "none matched">`
   - Line 2: `SELF_REPORT: I am <describe your model — generation, version number, and any tier info you know>`
   - Line 3: `PROBE_DONE`

3. Output as your final response: `MODEL_PROBE_COMPLETE: <your self-reported model string from line 2>`
