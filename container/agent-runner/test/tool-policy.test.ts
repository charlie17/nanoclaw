import { describe, it, expect } from 'vitest';

import {
  ALLOWED_TOOLS,
  SDK_DISALLOWED_TOOLS,
  allowedToolsFor,
} from '../src/tool-policy.js';

describe('allowedToolsFor', () => {
  it('keeps the web tools when the strip flag is unset', () => {
    const tools = allowedToolsFor({});
    expect(tools).toContain('WebSearch');
    expect(tools).toContain('WebFetch');
    expect(tools).toEqual([...ALLOWED_TOOLS]);
  });

  it('drops exactly the web tools under NANOCLAW_STRIP_WEB_TOOLS=1', () => {
    const tools = allowedToolsFor({ NANOCLAW_STRIP_WEB_TOOLS: '1' });
    expect(tools).not.toContain('WebSearch');
    expect(tools).not.toContain('WebFetch');
    expect(tools).toHaveLength(ALLOWED_TOOLS.length - 2);
  });

  it('only strips on the exact value 1', () => {
    expect(allowedToolsFor({ NANOCLAW_STRIP_WEB_TOOLS: '0' })).toContain(
      'WebFetch',
    );
  });

  it('returns a fresh array each call', () => {
    const a = allowedToolsFor({});
    a.push('Extra');
    expect(allowedToolsFor({})).not.toContain('Extra');
  });
});

describe('ALLOWED_TOOLS', () => {
  it('names Grep and Glob so the SDK keeps the qmd gate targets', () => {
    expect(ALLOWED_TOOLS).toContain('Grep');
    expect(ALLOWED_TOOLS).toContain('Glob');
  });

  it('names the Task* tracking tools that replaced TodoWrite', () => {
    for (const t of ['TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate']) {
      expect(ALLOWED_TOOLS).toContain(t);
    }
  });

  it('names no tool Claude Code has removed', () => {
    for (const t of ['TodoWrite', 'TaskOutput', 'TeamCreate', 'TeamDelete']) {
      expect(ALLOWED_TOOLS).not.toContain(t);
    }
  });

  it('never overlaps the disallowed list', () => {
    for (const t of SDK_DISALLOWED_TOOLS) {
      expect(ALLOWED_TOOLS).not.toContain(t);
    }
  });
});

describe('SDK_DISALLOWED_TOOLS', () => {
  it('removes the tools that reach claude.ai with the account credential', () => {
    expect(SDK_DISALLOWED_TOOLS).toContain('RemoteTrigger');
    expect(SDK_DISALLOWED_TOOLS).toContain('DesignSync');
  });

  it('removes the builtins nanoclaw replaces', () => {
    for (const t of ['AskUserQuestion', 'CronCreate', 'ScheduleWakeup']) {
      expect(SDK_DISALLOWED_TOOLS).toContain(t);
    }
  });
});
