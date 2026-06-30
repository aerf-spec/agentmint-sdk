import { readFileSync } from "node:fs";
import type { AgentMintSpec, RuleAction } from "./types.js";

// ── Minimal YAML subset parser ─────────────────────────────────────
// Handles: scalars, maps, sequences, comments, quoted strings.
// No anchors, aliases, flow mappings, or multi-line blocks.

function parseYamlValue(raw: string): unknown {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1);
  // Inline list: [a, b, c]
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((v) => parseYamlValue(v.trim()));
  }
  return s;
}

interface YLine {
  indent: number;
  raw: string;
  isList: boolean;
  key?: string;
  value?: string;
}

function tokenize(input: string): YLine[] {
  const lines: YLine[] = [];
  for (const line of input.split("\n")) {
    // Strip comments (but not inside quotes)
    let cleaned = line;
    const hashIdx = cleaned.search(/(?<!['"]\S*)#/);
    if (hashIdx > 0 && cleaned[hashIdx - 1] === " ") {
      cleaned = cleaned.slice(0, hashIdx);
    }
    if (cleaned.trimStart().startsWith("#")) continue;
    const trimmed = cleaned.trimEnd();
    if (trimmed.length === 0) continue;

    const indent = trimmed.length - trimmed.trimStart().length;
    const content = trimmed.trimStart();
    const isList = content.startsWith("- ");
    const body = isList ? content.slice(2) : content;

    const colonMatch = body.match(/^([^:]+):\s*(.*)/);
    if (colonMatch) {
      lines.push({
        indent: isList ? indent + 2 : indent,
        raw: body,
        isList,
        key: colonMatch[1]!.trim(),
        value: colonMatch[2]!.trim() || undefined,
      });
    } else {
      lines.push({ indent, raw: body, isList, value: body.trim() });
    }
  }
  return lines;
}

function buildTree(lines: YLine[], start: number, parentIndent: number): { value: unknown; end: number } {
  if (start >= lines.length) return { value: null, end: start };

  const line = lines[start]!;

  // Check if this starts a list
  if (line.isList || (start + 1 < lines.length && lines[start + 1]!.isList && lines[start + 1]!.indent > parentIndent)) {
    // If current line is a key with no value and next line is a list item
    if (line.key && !line.isList) {
      const arr: unknown[] = [];
      let i = start + 1;
      while (i < lines.length && lines[i]!.indent > parentIndent) {
        const child = lines[i]!;
        if (!child.isList) break;
        if (child.key) {
          // List of maps
          const obj: Record<string, unknown> = {};
          obj[child.key] = child.value ? parseYamlValue(child.value) : undefined;
          // Read children
          let j = i + 1;
          while (j < lines.length && lines[j]!.indent > child.indent) {
            const sub = buildTree(lines, j, child.indent);
            if (lines[j]!.key) {
              obj[lines[j]!.key!] = sub.value;
            }
            j = sub.end;
          }
          if (obj[child.key] === undefined) {
            const sub = buildTree(lines, i + 1, child.indent);
            obj[child.key] = sub.value;
            i = sub.end;
          } else {
            i = j;
          }
          arr.push(obj);
        } else {
          arr.push(parseYamlValue(child.value ?? child.raw));
          i++;
        }
      }
      return { value: arr, end: i };
    }
  }

  // Map entry with children
  if (line.key && !line.value) {
    // Check if children are list items
    if (start + 1 < lines.length && lines[start + 1]!.indent > line.indent) {
      const nextLine = lines[start + 1]!;
      if (nextLine.isList) {
        // It's a list
        const arr: unknown[] = [];
        let i = start + 1;
        while (i < lines.length && lines[i]!.indent > line.indent) {
          if (lines[i]!.isList) {
            arr.push(parseYamlValue(lines[i]!.value ?? lines[i]!.raw));
          }
          i++;
        }
        return { value: arr, end: i };
      }
      // It's a nested map
      const obj: Record<string, unknown> = {};
      let i = start + 1;
      while (i < lines.length && lines[i]!.indent > line.indent) {
        const child = lines[i]!;
        if (child.key) {
          if (child.value) {
            obj[child.key] = parseYamlValue(child.value);
            i++;
          } else {
            const sub = buildTree(lines, i, child.indent);
            obj[child.key] = sub.value;
            i = sub.end;
          }
        } else {
          i++;
        }
      }
      return { value: obj, end: i };
    }
    return { value: null, end: start + 1 };
  }

  // Simple key: value
  if (line.key && line.value) {
    return { value: parseYamlValue(line.value), end: start + 1 };
  }

  // Plain value
  return { value: parseYamlValue(line.value ?? line.raw), end: start + 1 };
}

export function parseYaml(input: string): Record<string, unknown> {
  const lines = tokenize(input);
  const result: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.key) {
      if (line.value) {
        result[line.key] = parseYamlValue(line.value);
        i++;
      } else {
        const sub = buildTree(lines, i, line.indent);
        result[line.key] = sub.value;
        i = sub.end;
      }
    } else {
      i++;
    }
  }
  return result;
}

// ── Spec Loader ────────────────────────────────────────────────────

export function loadSpec(pathOrContent: string): AgentMintSpec {
  let content: string;
  if (pathOrContent.includes("\n") || pathOrContent.includes(":")) {
    content = pathOrContent;
  } else {
    content = readFileSync(pathOrContent, "utf-8");
  }

  const raw = parseYaml(content) as Record<string, unknown>;

  if (!raw["version"]) {
    throw new Error(
      'agentmint spec: expected a top-level "version" field, but none was found. ' +
        'Add `version: "1.0"` to the top of your spec.',
    );
  }

  return raw as unknown as AgentMintSpec;
}

export function loadSpecFromFile(filePath: string): AgentMintSpec {
  const content = readFileSync(filePath, "utf-8");
  return loadSpec(content);
}

export function resolveAction(
  propAction: RuleAction | undefined,
  toolAction: RuleAction | undefined,
  globalAction: RuleAction | undefined,
  categoryDefault: RuleAction,
): RuleAction {
  return propAction ?? toolAction ?? globalAction ?? categoryDefault;
}
