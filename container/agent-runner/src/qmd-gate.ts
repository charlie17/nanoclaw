/**
 * qmd-first gate — pure logic for the two Agent SDK hooks wired in index.ts.
 *
 * WHY: "search the vault with qmd before you grep it" was prose in a skill /
 * CLAUDE.md, and prose does not bind the model. The expensive failure is the
 * agent grepping the vault for a literal string, finding nothing, and telling
 * JT "there's nothing in your vault about X" — a grep can never establish
 * absence of a *concept*, only of a *string*. This module makes the harness
 * enforce it:
 *
 *   Layer 1 (deterministic, PreToolUse): no vault grep/glob/find until a
 *           mcp__qmd__query has succeeded this turn.
 *   Layer 2 (heuristic, Stop): don't let the turn end on an absence claim
 *           when no qmd query ran.
 *
 * Kept dependency-free and side-effect-free so it is unit-testable from the
 * repo-root vitest suite (see qmd-gate.test.ts).
 */

/** Container mount point of the Obsidian vault. */
export const VAULT_MOUNT = '/workspace/extra/vault';

/** The MCP tool whose success unlocks the gate. */
export const QMD_QUERY_TOOL = 'mcp__qmd__query';

/** Shown to the model when layer 1 blocks a call. */
export const VAULT_GREP_BLOCK_REASON =
  "Vault lookups are qmd-first: run mcp__qmd__query (a vec sub-query, rerank:false, collections:['general']) before any grep/glob of /workspace/extra/vault. Grep is supplementary and can never establish absence.";

/** Shown to the model when layer 2 blocks a stop. */
export const ABSENCE_CLAIM_BLOCK_REASON =
  "You asserted vault absence without a qmd semantic search this turn. Run mcp__qmd__query (vec, rerank:false, collections:['general']), reshape the query toward the concept if the first hits are the wrong kind, then answer.";

/**
 * Matches `/workspace/extra/vault`, a bare `extra/vault`, and any path under
 * either. The negative lookahead keeps `extra/vaultarium` from matching.
 */
const VAULT_PATH_RE = /extra\/vault(?![\w-])/;

/** Search/enumeration verbs that would walk the vault tree from a shell. */
const BASH_SEARCH_RE =
  /(?:^|[\s;|&(`$])(?:grep|egrep|fgrep|rg|ripgrep|find)(?![\w-])|(?:^|[\s;|&(`$])ls\s+(?:-\w*\s+)*-?\w*R/;

/**
 * Absence-claim phrasings that stand on their own — they either name the vault
 * outright, or assert a failed search in terms too specific to fire on ordinary
 * prose. Matched against a single sentence with no further conditions.
 */
const ABSENCE_CLAIM_SOURCES = [
  // "nothing in the vault", "there's nothing on that in your vault",
  // "nothing in your notes". The lazy word-gap allows a few intervening words.
  // The lookahead excludes the RESTRICTIVE reading, which is not an absence
  // claim: "nothing in the vault is more recent than 9/10" is a statement about
  // what the vault DOES have.
  'nothing\\s+(?:\\w+\\s+){0,3}?in\\s+(?:the|your|my)\\s+(?:vault|notes)(?!\\s+(?:is|are|was|were|has|have|do|does)\\b)',
  // "nothing found in ...", "found nothing about X", "nothing turned up"
  'nothing\\s+(?:was\\s+)?found\\s+in',
  '\\bfound\\s+nothing\\b',
  '\\bnothing\\s+(?:turned|came)\\s+up\\b',
  // "no notes of/about/on", "no note on X", "no mention of X in the vault",
  // "no record of it". These nouns are knowledge-shaped, so they carry their
  // own vault context; the generic ones below do not.
  '\\bno\\s+(?:notes?|mentions?|records?)\\s+(?:of|about|on|for|in|regarding)\\b',
  // "no matching notes", "no relevant entries"
  '\\bno\\s+(?:matching|relevant|related|such)\\s+(?:notes|entries|results|matches|records?|files)\\b',
  // "not in the vault", "not anywhere in your vault"
  '\\bnot\\s+(?:in|anywhere\\s+in)\\s+(?:the|your|my)\\s+vault',
  // "couldn't find anything", "didn't find any", "can't locate anything",
  // "cannot find any"
  "(?:cannot|(?:could|did|can)(?:n['’]?t|\\s+not))\\s+(?:find|see|locate|turn\\s+up)\\s+(?:anything|any)\\b",
  // "I don't see anything about X in your notes".
  // Deliberately narrow: `see|find|locate` only. Widening to `have` would fire
  // on the innocuous "I don't have any other updates."
  "\\bdo(?:es)?(?:n['’]?t|\\s+not)\\s+(?:see|find|locate)\\s+(?:anything|any)\\b",
  // "your notes don't mention X", "the vault doesn't have anything on X"
  "\\b(?:vault|notes)\\s+do(?:es)?(?:n['’]?t|\\s+not)\\s+(?:mention|have|contain|include|cover|say|show)\\b",
  // "no vault content/notes/entries"
  '\\bno\\s+vault\\s+(?:content|notes|entries)\\b',
  // "the vault has nothing", "vault contains nothing"
  'vault\\s+(?:has|contains)\\s+nothing',
];

export const ABSENCE_CLAIM_REGEX = new RegExp(
  ABSENCE_CLAIM_SOURCES.join('|'),
  'i',
);

/**
 * Absence phrasings built on nouns that carry NO vault connotation. On their
 * own these fire on perfectly ordinary engineering prose — "There are no
 * results for this API request", "No entries about X need changing" — so they
 * only count when the same sentence also mentions the vault (see
 * VAULT_CONTEXT_REGEX). "no entries about WSJ in your notes" passes; "no
 * entries about X need changing" does not.
 */
const ABSENCE_CLAIM_CONTEXTUAL_SOURCES = [
  '\\bno\\s+(?:entries|results|matches|hits)\\s+(?:of|about|on|for|in|regarding)\\b',
  // "there isn't anything in the vault about X" — but NOT the everyday
  // "there aren't any other changes", which this shape matches just as well.
  "(?:is|are|was|were)(?:n['’]?t|\\s+not)\\s+(?:anything|any)\\b",
];

export const ABSENCE_CLAIM_CONTEXTUAL_REGEX = new RegExp(
  ABSENCE_CLAIM_CONTEXTUAL_SOURCES.join('|'),
  'i',
);

/** What counts as "this sentence is talking about the vault". */
export const VAULT_CONTEXT_REGEX = /\b(?:vault|notes?|logs?|references?)\b/i;

/**
 * Sentence splitter for the contextual patterns. `;` is included on purpose:
 * "No entries about X need changing; I found three relevant vault notes" is two
 * independent clauses, and without the split the second clause's "vault" would
 * license the first clause's phrasing.
 */
const SENTENCE_SPLIT_REGEX = /[.!?;\n]+/;

function referencesVault(value: unknown): boolean {
  return typeof value === 'string' && VAULT_PATH_RE.test(value);
}

/**
 * Layer 1 predicate: is this tool call a filesystem search of the vault?
 *
 * `Read` is deliberately absent — reading a note you already located is always
 * allowed; only *discovery* is gated.
 */
export function isVaultGrepCall(toolName: string, input: unknown): boolean {
  const args = (input ?? {}) as Record<string, unknown>;

  if (toolName === 'Grep' || toolName === 'Glob') {
    // `path` is the documented arg; `pattern`/`glob`/`cwd` are checked too so a
    // vault path smuggled in as the pattern (e.g. Glob on
    // "/workspace/extra/vault/**/*.md") is still caught.
    return (
      referencesVault(args.path) ||
      referencesVault(args.pattern) ||
      referencesVault(args.glob) ||
      referencesVault(args.cwd)
    );
  }

  if (toolName === 'Bash') {
    const command = typeof args.command === 'string' ? args.command : '';
    if (!command) return false;
    return BASH_SEARCH_RE.test(command) && VAULT_PATH_RE.test(command);
  }

  return false;
}

/**
 * Layer 2 predicate: does this assistant text assert vault absence?
 *
 * Evaluated sentence by sentence so a vault mention in one clause cannot
 * license a generic absence phrase in another.
 */
export function looksLikeAbsenceClaim(
  text: string | undefined | null,
): boolean {
  if (!text) return false;
  for (const sentence of text.split(SENTENCE_SPLIT_REGEX)) {
    if (!sentence.trim()) continue;
    if (ABSENCE_CLAIM_REGEX.test(sentence)) return true;
    if (
      ABSENCE_CLAIM_CONTEXTUAL_REGEX.test(sentence) &&
      VAULT_CONTEXT_REGEX.test(sentence)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * An MCP failure that arrives as prose rather than as an error flag. The qmd
 * server reports daemon-down and bad-argument conditions this way, e.g.
 * `[{type:'text', text:'Error: qmd daemon unavailable'}]`.
 */
const MCP_ERROR_TEXT_REGEX = /^\s*(?:mcp\s+error|error)\b/i;

/** First text-bearing block of an MCP content array, or null. */
function firstTextBlock(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  for (const block of blocks) {
    if (typeof block === 'string') return block;
    if (block && typeof block === 'object') {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === 'string') return text;
    }
  }
  return null;
}

/**
 * Did a PostToolUse event represent a *successful* qmd query?
 *
 * FAILS CLOSED. This function unlocks the gate, so every uncertain shape has to
 * resolve to `false` — an unlocked gate on a query that never ran is exactly
 * the failure the gate exists to prevent. The SDK types `tool_response` as
 * `unknown`, and qmd errors reach us in three different shapes:
 *
 *   - absent entirely (`undefined`/`null`) — no evidence a search happened
 *   - a top-level `is_error` / `isError` flag
 *   - ordinary-looking content whose first text block is an error message
 *     (bare string, `[{type:'text', text:'Error: …'}]`, or `{content:[…]}`)
 *
 * A zero-hit query IS a success: the agent did the semantic search and may then
 * legitimately grep to double-check.
 */
export function isQmdQuerySuccess(
  toolName: string,
  toolResponse: unknown,
): boolean {
  if (toolName !== QMD_QUERY_TOOL) return false;

  // No response at all is not evidence that a search ran.
  if (toolResponse === null || toolResponse === undefined) return false;

  if (typeof toolResponse === 'string') {
    return !MCP_ERROR_TEXT_REGEX.test(toolResponse);
  }

  if (Array.isArray(toolResponse)) {
    const first = firstTextBlock(toolResponse);
    return first === null || !MCP_ERROR_TEXT_REGEX.test(first);
  }

  if (typeof toolResponse === 'object') {
    const r = toolResponse as Record<string, unknown>;
    if (r.is_error === true || r.isError === true) return false;
    const first = firstTextBlock(r.content);
    if (first !== null && MCP_ERROR_TEXT_REGEX.test(first)) return false;
    return true;
  }

  return true;
}

/**
 * Per-turn state shared by the two hooks.
 *
 * TURN BOUNDARY = UserPromptSubmit, not query() start.
 *
 * The runner's `runQuery()` opens ONE `query()` per outer-loop iteration but
 * keeps pushing later IPC messages into the same live MessageStream
 * (index.ts `pollIpcDuringQuery`). So a single query() can carry many user
 * turns, and resetting only at query() start would let one qmd query at 09:00
 * unlock vault greps for every message that follows for the life of the
 * container. UserPromptSubmit fires once per user message on both paths
 * (initial prompt and IPC-piped follow-up), which is exactly the granularity
 * the rule is about. `resetTurn()` is also called at query() start, which is
 * redundant-but-harmless belt-and-braces for a resumed session.
 *
 * Hook closures run in-process in the runner, so a plain object is sufficient
 * state; nothing is persisted across container restarts (correctly — a fresh
 * container starts locked).
 */
export interface QmdTurnState {
  /** True once mcp__qmd__query has succeeded since the last turn boundary. */
  hasQmdThisTurn(): boolean;
  /** Called from PostToolUse when a qmd query succeeds. */
  markQmdSuccess(): void;
  /** Called at the turn boundary (UserPromptSubmit / query start). */
  resetTurn(): void;
}

export function createQmdTurnState(): QmdTurnState {
  let qmdSucceeded = false;
  return {
    hasQmdThisTurn: () => qmdSucceeded,
    markQmdSuccess: () => {
      qmdSucceeded = true;
    },
    resetTurn: () => {
      qmdSucceeded = false;
    },
  };
}

/**
 * Layer 1 decision. Returns a block reason, or null to allow.
 */
export function evaluateVaultGrepGate(
  state: QmdTurnState,
  toolName: string,
  input: unknown,
): string | null {
  if (state.hasQmdThisTurn()) return null;
  if (!isVaultGrepCall(toolName, input)) return null;
  return VAULT_GREP_BLOCK_REASON;
}

/**
 * Layer 2 decision. Returns a block reason, or null to allow the stop.
 *
 * `stopHookActive` short-circuits unconditionally: it means we already blocked
 * this stop once and the model is running again, so blocking a second time
 * would spin the turn forever.
 */
export function evaluateAbsenceClaimGate(
  state: QmdTurnState,
  stopHookActive: boolean,
  lastAssistantMessage: string | undefined | null,
): string | null {
  if (stopHookActive) return null;
  if (state.hasQmdThisTurn()) return null;
  if (!looksLikeAbsenceClaim(lastAssistantMessage)) return null;
  return ABSENCE_CLAIM_BLOCK_REASON;
}
