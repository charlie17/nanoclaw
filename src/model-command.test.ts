import { describe, it, expect } from 'vitest';

import { displayName, MODEL_MAP, parseModelCommand } from './model-command.js';

describe('parseModelCommand', () => {
  it('parses /model opus', () => {
    expect(parseModelCommand('/model opus')).toEqual({
      kind: 'set',
      model: 'opus',
    });
  });
  it('parses /model sonnet', () => {
    expect(parseModelCommand('/model sonnet')).toEqual({
      kind: 'set',
      model: 'sonnet',
    });
  });
  it('parses bare /model as show', () => {
    expect(parseModelCommand('/model')).toEqual({ kind: 'show' });
  });
  it('tolerates trailing whitespace on bare /model', () => {
    expect(parseModelCommand('/model   ')).toEqual({ kind: 'show' });
  });
  it('returns null for /model haiku (recognized prefix, unsupported arg)', () => {
    expect(parseModelCommand('/model haiku')).toBeNull();
  });
  it('returns null when /model is not the leading token', () => {
    expect(parseModelCommand('hello /model opus')).toBeNull();
  });
  it('returns null for unrelated slash commands', () => {
    expect(parseModelCommand('/research foo')).toBeNull();
  });
});

describe('MODEL_MAP + displayName', () => {
  it('maps opus / sonnet to SDK identifiers', () => {
    expect(MODEL_MAP.opus.id).toBe('claude-opus-4-7');
    expect(MODEL_MAP.sonnet.id).toBe('claude-sonnet-4-6');
  });
  it('displayName resolves identifier to label, falls back to raw id', () => {
    expect(displayName('claude-opus-4-7')).toBe('Opus');
    expect(displayName('claude-sonnet-4-6')).toBe('Sonnet');
    expect(displayName('claude-future-9-9')).toBe('claude-future-9-9');
  });
});
