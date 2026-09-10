export const COMPARISON_REPORT_LIMITS = Object.freeze({ reportBytes: 20 * 1024 * 1024, preparedBytes: 40 * 1024 * 1024 });

export class ComparisonPreparationLimitError extends RangeError {
  constructor(format, limitBytes) {
    super(`Comparison ${format} exceeds the ${limitBytes / 1024 / 1024} MiB preparation limit. No partial report was prepared. Export full source evidence or explicitly omit optional evidence and review again.`);
    this.name = "ComparisonPreparationLimitError";
    this.code = "comparison-preparation-limit";
    this.format = format;
    this.limitBytes = limitBytes;
  }
}

export function byteBudget(format, limit = COMPARISON_REPORT_LIMITS.reportBytes) {
  let used = 0;
  return { add(count) {
    used += count;
    if (used > limit) throw new ComparisonPreparationLimitError(format, limit);
    return used;
  } };
}

// Count without allocating encoded/escaped copies. Lone surrogates become
// replacement characters in UTF-8 and \uXXXX escapes in JSON.
export function countText(text, add, mode = "text") {
  for (const character of text) {
    const cp = character.codePointAt(0);
    const utf8 = cp > 0xffff ? 4 : cp > 0x7ff ? 3 : cp > 0x7f ? 2 : 1;
    if (mode === "json") {
      add(character === '"' || character === "\\" || [8, 9, 10, 12, 13].includes(cp) ? 2
        : cp < 32 || (cp >= 0xd800 && cp <= 0xdfff) ? 6 : utf8);
    } else if (mode === "markdown") {
      add(/[&<>\\`*_{}[\]()#+\-.!|:]/.test(character) ? `&#${cp};`.length : cp === 13 ? 0 : cp === 10 ? 4 : utf8);
    } else add(utf8);
  }
}

/** Exact size of stable JSON for generated JSON-shaped reports, including the
 * final newline. Visit repeated references each time: their expansion costs
 * bytes even if the model shares an object. Stop before building the string.
 */
export function checkReportJsonSize(value, space = 2) {
  const budget = byteBudget("report-json");
  const add = count => budget.add(count);
  const ancestors = new Set();
  const visit = (item, depth) => {
    if (item === null || typeof item !== "object") {
      if (typeof item === "string") { add(2); countText(item, add, "json"); }
      else add(JSON.stringify(item)?.length ?? 4);
      return;
    }
    if (ancestors.has(item)) throw new TypeError("Cyclic report is unsupported.");
    ancestors.add(item);
    const array = Array.isArray(item);
    const keys = array ? Array.from({ length: item.length }, (_, i) => i) : Object.keys(item).filter(key => item[key] !== undefined);
    add(2);
    for (let i = 0; i < keys.length; i++) {
      if (i) add(1);
      if (space) add(1 + (depth + 1) * space);
      const key = keys[i];
      if (!array) { add(3 + (space ? 1 : 0)); countText(key, add, "json"); }
      visit(item[key], depth + 1);
    }
    if (space && keys.length) add(1 + depth * space);
    ancestors.delete(item);
  };
  visit(value, 0);
  return budget.add(1);
}
