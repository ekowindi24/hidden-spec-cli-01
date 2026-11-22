// mend: one patch tool for every AI edit format (SPEC.md v1).
// Node 22, standard library alone. Run as `node main.ts [options] [PATCH]`.
// Implements SPEC.md sections 1-10: CLI, output, safe paths, format
// detection, three-tier line matching, unified diffs, SEARCH/REPLACE,
// V4A patches, JSON edits, and all-or-nothing writes. In a trial the
// last lines hand over to runner.ts when MAKEFUN_ENV_URL is set.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;
type Move = { old: string; new: string };

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- file line handling (SPEC section 3) ----

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > fileLines.length) return out;
  for (let i = from; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(fileLines[i + j]!, tier) !== normLine(o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier (0, then 1, then 2; strict: only 0) with an occurrence at/after `from`.
function findTier(fileLines: string[], o: string[], strict: boolean, from: number): { tier: number; positions: number[] } | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const positions = occurrencesAt(fileLines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// Build the replacement lines N from O/N with context mapping.
// nCtx[i] is the index into O of a context line, or null for a pure new line.
function buildNew(fileLines: string[], o: string[], n: string[], nCtx: (number | null)[], tier: number, pos: number): string[] {
  if (o.length === 0) return [...n];
  const f = leadingWs(fileLines[pos] ?? '');
  const p = leadingWs(o[0] ?? '');
  return n.map((line, i) => {
    const ctx = nCtx[i];
    if (ctx !== null && ctx !== undefined) return fileLines[pos + ctx]!;
    if (tier === 2) {
      if (line === '' || line.trim() === '') return line;
      if (line.startsWith(p)) return f + line.slice(p.length);
      return line;
    }
    return line;
  });
}

// Apply one hunk/chunk (O -> N) to curLines at the chosen position.
function applyReplace(curLines: string[], o: string[], n: string[], nCtx: (number | null)[], tier: number, pos: number): string[] {
  const repl = buildNew(curLines, o, n, nCtx, tier, pos);
  return [...curLines.slice(0, pos), ...repl, ...curLines.slice(pos + o.length)];
}


// ---- JSON edits (SPEC section 9) ----

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- unified diffs (SPEC section 6) ----

function stripDiffPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function parseDiffPath(line: string): string {
  // line starts with '--- ' or '+++ '; text after the four characters,
  // up to the first tab, surrounding spaces removed.
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  return rest.trim();
}

interface Hunk {
  a: number;
  o: string[];
  n: string[];
  nCtx: (number | null)[];
  noNewline: boolean;
}

interface Section {
  oldPath: string | null; // null = /dev/null
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function parseHunkBody(lines: string[], i: number): { hunk: Hunk; next: number } {
  // lines[i] is the @@ header; caller already validated it.
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[i]!);
  const a = Number(m![1]);
  let j = i + 1;
  const body: string[] = [];
  while (j < lines.length) {
    const line = lines[j]!;
    if (line.startsWith('diff --git ')) break;
    if (line.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
      body.push(line);
      j++;
    } else break;
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const line of body) {
    if (line.startsWith(' ')) {
      const t = line.slice(1);
      o.push(t);
      nCtx.push(o.length - 1);
      n.push(t);
    } else if (line.startsWith('-')) {
      o.push(line.slice(1));
    } else if (line.startsWith('+')) {
      n.push(line.slice(1));
      nCtx.push(null);
    } else if (line === '') {
      o.push('');
      nCtx.push(o.length - 1);
      n.push('');
    }
    // '\' lines are not lines of O or N; they only mark no-newline.
  }
  // A '\' line right after the hunk's last context or '+' line.
  let noNewline = false;
  let lastContent = -1;
  for (let k = 0; k < body.length; k++) {
    const b = body[k]!;
    if (b.startsWith(' ') || b.startsWith('+') || b === '') lastContent = k;
  }
  if (lastContent >= 0 && body[lastContent + 1] !== undefined && body[lastContent + 1]!.startsWith('\\')) noNewline = true;
  return { hunk: { a, o, n, nCtx, noNewline }, next: j };
}

function unifiedEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    let sec: Section | null = null;
    let gitOld: string | null = null;
    let gitNew: string | null = null;
    let headerOld: string | null = null;
    let headerNew: string | null = null;
    let renameOld: string | null = null;
    let renameNew: string | null = null;
    let isCreate = false;
    let isDelete = false;
    let sectionStart = i;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      gitOld = m[1]!;
      gitNew = m[2]!;
      sectionStart = i;
      i++;
      // header lines until first hunk, next section, or end
      while (i < lines.length) {
        const h = lines[i]!;
        if (h.startsWith('@@')) break;
        if (h.startsWith('diff --git ')) break;
        if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (h.startsWith('--- ')) {
          if (h.startsWith('--- ') && !(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
          break;
        }
        if (h.startsWith('rename from ')) renameOld = h.slice('rename from '.length).trim();
        else if (h.startsWith('rename to ')) renameNew = h.slice('rename to '.length).trim();
        else if (h.startsWith('new file mode')) isCreate = true;
        else if (h.startsWith('deleted file mode')) isDelete = true;
        i++;
      }
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sectionStart = i;
      headerOld = parseDiffPath(line);
      headerNew = parseDiffPath(lines[i + 1]!);
      i += 2;
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    // At this point we are in a section (diff or ---/+++). Parse ---/+++ if
    // present as the section's own header (diff case), then hunks.
    if (gitOld !== null) {
      // A ---/+++ pair may follow the diff header lines.
      if (i < lines.length && lines[i]!.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        headerOld = parseDiffPath(lines[i]!);
        headerNew = parseDiffPath(lines[i + 1]!);
        i += 2;
      }
    }
    const hunks: Hunk[] = [];
    while (i < lines.length && lines[i]!.startsWith('@@')) {
      if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/.test(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunkBody(lines, i);
      hunks.push(parsed.hunk);
      i = parsed.next;
    }
    // Resolve paths: ---/+++ wins, then rename, then diff --git.
    let oldPath: string | null;
    let newPath: string | null;
    if (headerOld !== null || headerNew !== null) {
      oldPath = headerOld === '/dev/null' ? null : headerOld === null ? null : stripDiffPrefix(headerOld);
      newPath = headerNew === '/dev/null' ? null : headerNew === null ? null : stripDiffPrefix(headerNew);
      // A --- without +++ was already a parse error; a lone +++ is not a pair.
      if (headerOld === null || headerNew === null) {
        oldPath = headerOld === null ? (gitOld ?? null) : oldPath;
        newPath = headerNew === null ? (gitNew ?? null) : newPath;
      }
    } else if (renameOld !== null || renameNew !== null) {
      oldPath = renameOld;
      newPath = renameNew;
    } else {
      oldPath = gitOld;
      newPath = gitNew;
    }
    if (oldPath === null && newPath === null && !isCreate && !isDelete) {
      throw new Exit2(`error: parse ${sectionStart + 1}`);
    }
    if (oldPath === null) isCreate = true;
    if (newPath === null) isDelete = true;
    // A section whose ---/+++ names /dev/null on one side is create/delete
    // even without the mode lines.
    sec = { oldPath, newPath, isCreate, isDelete, hunks };
    sections.push(sec);
    // Loop continues: prose / next section / hunks of the same section
    // without a header are handled because a bare @@ line here would
    // throw; in practice hunks follow their header directly.
  }
  if (sections.length === 0) return [];
  return sections.map((sec) => (tree: Tree): void => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (sec.isCreate) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noNl = false;
      for (const h of sec.hunks) {
        // + lines of this hunk, in order; note whether a '\' follows its last '+'.
        const bodyPlus: string[] = [];
        for (let k = 0; k < h.n.length; k++) {
          // n holds context and '+' lines mixed; recover '+' lines by
          // re-deriving from nCtx: null entries are '+' lines.
          if (h.nCtx[k] === null) bodyPlus.push(h.n[k]!);
        }
        plus.push(...bodyPlus);
        if (bodyPlus.length > 0) noNl = h.noNewline;
      }
      const text = plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n');
      tree.now.set(p, text);
      return;
    }
    if (sec.isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const isMove = oldP !== null && newP !== null && oldP !== newP;
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (isMove && tree.get(newP!) !== null) throw new Fail('exists', newP!);
    const parts = splitFile(before);
    let curLines = [...parts.lines];
    let curFinal = parts.final;
    let d = 0;
    for (const h of sec.hunks) {
      if (h.o.length === 0) {
        const at = Math.min(h.a + d, curLines.length);
        const atEnd = at === curLines.length;
        curLines = [...curLines.slice(0, at), ...h.n, ...curLines.slice(at)];
        if (atEnd) curFinal = !h.noNewline;
        d += h.n.length;
        continue;
      }
      const found = findTier(curLines, h.o, strict, 0);
      if (!found) throw new Fail('no-match', p);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      for (const pos of found.positions) {
        if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
      }
      const beforeLen = curLines.length;
      const endsAtEnd = best + h.o.length === beforeLen;
      curLines = applyReplace(curLines, h.o, h.n, h.nCtx, found.tier, best);
      if (endsAtEnd) curFinal = !h.noNewline;
      d += h.n.length - h.o.length;
    }
    const text = joinFile(curLines, parts.br, curFinal);
    if (isMove) {
      tree.now.set(p, null);
      tree.now.set(newP!, text);
      moves.push({ old: p, new: newP! });
    } else {
      tree.now.set(p, text);
    }
  });
}


// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1; // index of previous block's >>>>>>> line
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchIdx = i;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { sep = j; break; }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, sep);
    const newLines = lines.slice(sep + 1, end);
    // Path: nearest line before SEARCH, after the previous block, that is
    // not blank and does not start with three backticks.
    let path: string | null = null;
    for (let k = searchIdx - 1; k > prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    prevPath = path;
    prevEnd = end;
    const p = path;
    const o = [...oldLines];
    const n = [...newLines];
    edits.push((tree: Tree): void => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (o.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const parts = splitFile(before);
      const found = findTier(parts.lines, o, strict, 0);
      if (!found) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = found.positions[0]!;
      const nCtx: (number | null)[] = n.map(() => null);
      const curLines = applyReplace(parts.lines, o, n, nCtx, found.tier, pos);
      tree.now.set(p, joinFile(curLines, parts.br, parts.final));
    });
    i = end + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC section 8) ----

interface V4aChunk {
  anchor: string | null;
  body: { kind: ' ' | '-' | '+'; text: string }[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[]; // add: file lines
  chunks: V4aChunk[];
  lineNo: number; // 1-based Update File line, for parse errors
}

function v4aEdits(lines: string[], strict: boolean, moves: Move[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) return k;
    return -1;
  })();
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let idx = first + 1;
  while (idx < last) {
    if (blank(lines[idx]!)) { idx++; continue; }
    const line = lines[idx]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const start = idx;
      idx++;
      const collected: string[] = [];
      while (idx < last) {
        const l = lines[idx]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l.startsWith('+')) { collected.push(l.slice(1)); idx++; continue; }
        if (l === '') { collected.push(''); idx++; continue; }
        throw new Exit2(`error: parse ${idx + 1}`);
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
      sections.push({ kind: 'add', path, moveTo: null, lines: collected, chunks: [], lineNo: start + 1 });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      sections.push({ kind: 'delete', path, moveTo: null, lines: [], chunks: [], lineNo: idx + 1 });
      idx++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const start = idx;
      idx++;
      let moveTo: string | null = null;
      if (idx < last && lines[idx]!.startsWith('*** Move to: ')) {
        moveTo = lines[idx]!.slice('*** Move to: '.length).trim();
        idx++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.kind === ' ' && cur.body[cur.body.length - 1]!.text === '') cur.body.pop();
          chunks.push(cur);
          cur = null;
        }
      };
      while (idx < last) {
        const l = lines[idx]!;
        if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
        if (l === '*** End of File') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.eof = true;
          closeChunk();
          idx++;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk();
          const anchorText = l.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          idx++;
          continue;
        }
        if (l.startsWith('*** ')) throw new Exit2(`error: parse ${idx + 1}`);
        if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push({ kind: l[0] as ' ' | '-' | '+', text: l.slice(1) });
          idx++;
          continue;
        }
        if (l === '') {
          if (cur === null) cur = { anchor: null, body: [], eof: false };
          cur.body.push({ kind: ' ', text: '' });
          idx++;
          continue;
        }
        throw new Exit2(`error: parse ${idx + 1}`);
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
      sections.push({ kind: 'update', path, moveTo, lines: [], chunks, lineNo: start + 1 });
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  if (sections.length === 0) return [];
  return sections.map((sec) => (tree: Tree): void => {
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    // update
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const parts = splitFile(before);
    let curLines = [...parts.lines];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const foundA = findTier(curLines, [chunk.anchor], strict, cursor);
        if (!foundA) throw new Fail('no-match', sec.path);
        cursor = foundA.positions[0]! + 1;
      }
      const o: string[] = [];
      const n: string[] = [];
      const nCtx: (number | null)[] = [];
      for (const b of chunk.body) {
        if (b.kind === ' ') { o.push(b.text); nCtx.push(o.length - 1); n.push(b.text); }
        else if (b.kind === '-') o.push(b.text);
        else { n.push(b.text); nCtx.push(null); }
      }
      if (o.length === 0) {
        const at = chunk.eof ? curLines.length : cursor;
        curLines = [...curLines.slice(0, at), ...n, ...curLines.slice(at)];
        cursor = at + n.length;
        continue;
      }
      let found: { tier: number; positions: number[] } | null = null;
      if (chunk.eof) {
        const maxTier = strict ? 0 : 2;
        for (let tier = 0; tier <= maxTier; tier++) {
          const all = occurrencesAt(curLines, o, tier, cursor);
          const eofPos = all.filter((pos) => pos + o.length === curLines.length);
          if (eofPos.length > 0) { found = { tier, positions: eofPos }; break; }
        }
        if (!found) throw new Fail('no-match', sec.path);
      } else {
        found = findTier(curLines, o, strict, cursor);
        if (!found) throw new Fail('no-match', sec.path);
      }
      const pos = found.positions[0]!;
      curLines = applyReplace(curLines, o, n, nCtx, found.tier, pos);
      cursor = pos + n.length;
    }
    const text = joinFile(curLines, parts.br, parts.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, text);
      moves.push({ old: sec.path, new: sec.moveTo });
    } else {
      tree.now.set(sec.path, text);
    }
  });
}


// ---- invocation (SPEC sections 1, 2, 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: Move[] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = [...moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = 0;
      moves.push(...movesBefore);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Changed paths, with R replacing a move's D + A pair (section 2).
  interface Row { kind: string; path: string; sortKey: string; old?: string; next?: string }
  const rowsMap = new Map<string, Row>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rowsMap.set(p, { kind: was === null ? 'A' : now === null ? 'D' : 'M', path: p, sortKey: p });
  }
  const outRows: Row[] = [];
  const consumed = new Set<string>();
  for (const mv of moves) {
    const dRow = rowsMap.get(mv.old);
    const aRow = rowsMap.get(mv.new);
    if (dRow && aRow && dRow.kind === 'D' && aRow.kind === 'A') {
      outRows.push({ kind: 'R', path: mv.new, sortKey: mv.new, old: mv.old, next: mv.new });
      consumed.add(mv.old);
      consumed.add(mv.new);
    }
  }
  for (const [p, r] of rowsMap) if (!consumed.has(p)) outRows.push(r);
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey), Buffer.from(b.sortKey)));
  const rows = outRows.map((r) => (r.kind === 'R' ? `R ${r.old} -> ${r.next}` : `${r.kind} ${r.path}`));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
