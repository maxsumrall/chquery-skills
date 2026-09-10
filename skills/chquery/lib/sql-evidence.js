// A bounded lexer, not a ClickHouse parser. Offsets refer to the original SQL.
export function sqlTokens(sql = "") {
  const tokens = [];
  const pattern = /\s+|--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|`(?:\\.|``|[^`\\])*`|[a-z_][\w$]*|\d+|[^\s]/gi;
  for (const match of sql.matchAll(pattern)) {
    const text = match[0];
    if (/^(?:\s|--|#|\/\*)/.test(text)) continue;
    const unsupported = /^["'`]$/.test(text) || (text === "/" && sql[match.index + 1] === "*") || text === "$";
    tokens.push({ text: unsupported ? "<unsupported>" : /^["'`]/.test(text) ? "<quoted>" : text.toLowerCase(), start: match.index, end: match.index + text.length,
      ...(/^["'`]/.test(text) ? { quoteKind: text[0] === "'" ? "string" : "identifier" } : {}) });
  }
  return tokens;
}

export function inspectSqlJoins(sql = "") {
  const tokens = sqlTokens(sql);
  let balance = 0;
  for (const token of tokens) {
    if (token.text === "<unsupported>") return [];
    if (token.text === "(") balance++;
    if (token.text === ")" && --balance < 0) return [];
  }
  if (balance) return [];
  const joins = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].text !== "join" || tokens[index - 1]?.text === "array") continue;
    let end = index + 1;
    let right = [];
    if (tokens[end]?.text === "(") {
      const start = ++end;
      let depth = 1;
      while (end < tokens.length && depth) {
        if (tokens[end].text === "(") depth++;
        if (tokens[end].text === ")") depth--;
        if (depth) end++;
      }
      if (depth) continue;
      right = tokens.slice(start, end).map(token => token.text);
      end++;
    }
    // Stop at the end of this FROM item; never borrow ON from another join.
    let on = end;
    while (on < tokens.length && !["on", "join", "where", "union", ")", ";"].includes(tokens[on].text)) on++;
    const predicate = tokens.slice(on + 1, on + 4).map(token => token.text).join(" ");
    const after = tokens[on + (predicate.startsWith("true") ? 2 : 4)]?.text;
    const constant = tokens[on]?.text === "on" &&
      (predicate === "1 = 1" || tokens[on + 1]?.text === "true") &&
      (after === undefined || ["where", "union", ")", ";", "group", "order", "limit", "inner", "left", "right", "cross", "join"].includes(after));
    const cross = tokens[index - 1]?.text === "cross" || constant;
    // Accept only SELECT MIN(identifier) [AS alias] FROM identifier[.identifier].
    // Grouping, windows, UNION, output expansion and unsupported forms fall back.
    const scalar = /^select min \( [a-z_][\w$]*(?: \. [a-z_][\w$]*)? \)(?: as [a-z_][\w$]*)? from [a-z_][\w$]*(?: \. [a-z_][\w$]*)?$/.test(right.join(" "));
    joins.push({ cross, scalar, source: "sql", start: tokens[index].start, end: tokens[Math.max(index, constant ? on + (predicate.startsWith("true") ? 1 : 3) : end - 1)]?.end, shape: constant ? "Constant-true JOIN condition in original SQL" : "CROSS JOIN in original SQL" });
  }
  return joins;
}

// This deliberately recognizes only a narrow proof shape. A qualified predicate
// over one side of one INNER JOIN is useful dependency evidence; everything else
// remains unknown rather than being guessed from identifier spelling.
export function inspectSqlFilterPushdown(sql = "") {
  const tokens = sqlTokens(sql);
  if (!tokens.length || tokens.some(token => token.text === "<unsupported>")) return { status: "unknown", reason: "SQL could not be safely tokenized." };
  const joins = tokens.flatMap((token, index) => token.text === "join" && tokens[index - 1]?.text !== "array" ? [index] : []);
  const where = tokens.findIndex(token => token.text === "where");
  if (joins.length !== 1 || where < 0) return { status: "unknown", reason: "Exactly one JOIN and one WHERE are required for supported dependency evidence." };
  const join = joins[0];
  const modifierNames = new Set(["global", "local", "any", "all", "asof", "semi", "anti", "inner", "left", "right", "full", "outer"]);
  let modifierStart = join;
  while (modifierStart > 0 && modifierNames.has(tokens[modifierStart - 1].text)) modifierStart -= 1;
  const modifiers = tokens.slice(modifierStart, join).map(token => token.text);
  const strictness = ["any", "asof", "semi", "anti"].find(value => modifiers.includes(value));
  if (strictness) return { status: "unsafe", joinKind: modifiers.find(value => ["left", "right", "full", "inner"].includes(value)) || "inner", reason: `${strictness.toUpperCase()} JOIN match semantics do not support this pushdown proof.` };
  const joinKind = ["left", "right", "full", "cross"].find(kind => modifiers.includes(kind)) || "inner";
  if (joinKind !== "inner") return { status: "unsafe", joinKind, reason: `${joinKind.toUpperCase()} JOIN null-preservation semantics require a separate equivalence proof.` };
  if (!modifiers.includes("all")) return { status: "unknown", joinKind, reason: "JOIN strictness is not explicit; the effective join_default_strictness is not established." };
  const from = tokens.findIndex((token, index) => index < modifierStart && token.text === "from");
  const on = tokens.findIndex((token, index) => index > join && index < where && token.text === "on");
  const sourceAlias = source => {
    const names = source.map(token => token.text);
    const tableEnd = names.length >= 3 && names[1] === "." ? 3 : 1;
    if (!/^[a-z_][\w$]*$/.test(names[0]) || (tableEnd === 3 && !/^[a-z_][\w$]*$/.test(names[2]))) return null;
    if (names.length === tableEnd) return names[tableEnd - 1];
    return names.length === tableEnd + 2 && names[tableEnd] === "as" && /^[a-z_][\w$]*$/.test(names[tableEnd + 1]) ? names[tableEnd + 1] : null;
  };
  const leftAlias = from >= 0 ? sourceAlias(tokens.slice(from + 1, modifierStart)) : null;
  const rightAlias = on >= 0 ? sourceAlias(tokens.slice(join + 1, on)) : null;
  if (!leftAlias || !rightAlias) return { status: "unknown", joinKind, reason: "JOIN sources, aliases, or strictness are outside the supported explicit source shape." };
  const projection = tokens.slice(1, from);
  const projectionItems = [];
  let projectionStart = 0;
  for (let index = 0; index <= projection.length; index += 1) {
    if (index === projection.length || projection[index].text === ",") { projectionItems.push(projection.slice(projectionStart, index)); projectionStart = index + 1; }
  }
  const simpleProjection = projection.length === 1 && projection[0].text === "*" || projectionItems.every(item => item.length === 3 &&
    /^[a-z_][\w$]*$/.test(item[0].text) && item[1].text === "." && (item[2].text === "*" || /^[a-z_][\w$]*$/.test(item[2].text)));
  if (tokens[0]?.text !== "select" || !simpleProjection) return { status: "unknown", joinKind, reason: "The SELECT projection is outside the supported star or qualified-column shape." };
  const boundary = tokens.findIndex((token, index) => index > where && ["group", "having", "order", "limit", "union", ";"].includes(token.text));
  const predicate = tokens.slice(where + 1, boundary < 0 ? tokens.length : boundary);
  if (!predicate.length || predicate.some(token => ["or", "select", "over", "exists"].includes(token.text))) return { status: "unknown", joinKind, reason: "The WHERE predicate is not in the supported conjunctive shape." };
  const qualifiers = new Set();
  for (let index = 0; index < predicate.length - 2; index += 1) {
    if (/^[a-z_][\w$]*$/.test(predicate[index].text) && predicate[index + 1].text === "." && /^[a-z_][\w$]*$/.test(predicate[index + 2].text)) qualifiers.add(predicate[index].text);
  }
  if (qualifiers.size !== 1) return { status: "unknown", joinKind, reason: "The predicate does not have one established qualified input dependency." };
  const qualifier = [...qualifiers][0];
  const clauses = [];
  let start = 0;
  for (let index = 0; index <= predicate.length; index += 1) {
    if (index === predicate.length || predicate[index].text === "and") { clauses.push(predicate.slice(start, index)); start = index + 1; }
  }
  const literal = token => token?.quoteKind === "string" || ["true", "false", "null"].includes(token?.text) || /^\d+$/.test(token?.text);
  const simple = clauses.every(clause => [5, 6].includes(clause.length) && clause[0].text === qualifier && clause[1].text === "." && /^[a-z_][\w$]*$/.test(clause[2].text) &&
    ((clause.length === 6 && ["!", "<", ">"].includes(clause[3].text) && clause[4].text === "=" && literal(clause[5])) ||
      (clause.length === 5 && clause[3].text === "is" && clause[4].text === "null") ||
      (clause.length === 6 && clause[3].text === "is" && clause[4].text === "not" && clause[5].text === "null") ||
      (clause.length === 5 && ["=", "<", ">"].includes(clause[3].text) && literal(clause[4]))));
  if (!simple) return { status: "unknown", joinKind, reason: "The predicate is not a supported simple one-input comparison." };
  if (![leftAlias, rightAlias].includes(qualifier)) return { status: "unknown", joinKind, reason: "The sole qualifier is not an explicitly parsed JOIN input alias." };
  return { status: "supported", joinKind, qualifier, reason: "A qualified conjunctive predicate references one established input of one INNER JOIN." };
}
