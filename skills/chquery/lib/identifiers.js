export function parseTableReference(description) {
  if (typeof description !== "string" || !description) return null;
  if (!description.includes(".")) return null;
  const identifier = /[\p{L}\p{N}_]/u;

  const previousIndex = index => {
    if (index >= 2 && /[\uDC00-\uDFFF]/.test(description[index - 1]) && /[\uD800-\uDBFF]/.test(description[index - 2])) return index - 2;
    return index - 1;
  };
  const left = end => {
    if (description[end - 1] === "`" || description[end - 1] === '"') {
      const quote = description[end - 1];
      for (let start = end - 2; start >= 0; start--) {
        if (description[start] !== quote) continue;
        if (description[start - 1] === quote) { start--; continue; }
        const raw = description.slice(start + 1, end - 1);
        if (raw) return { value: raw.replaceAll(quote + quote, quote), start };
      }
      return null;
    }
    let start = end;
    while (start > 0) {
      const previous = previousIndex(start);
      if (!identifier.test(description.slice(previous, start))) break;
      start = previous;
    }
    return start < end && !/[`"]/.test(description[start - 1] || "") ? { value: description.slice(start, end), start } : null;
  };
  const right = start => {
    if (description[start] === "`" || description[start] === '"') {
      const quote = description[start];
      let value = "";
      for (let index = start + 1; index < description.length; index++) {
        if (description[index] !== quote) { value += description[index]; continue; }
        if (description[index + 1] === quote) { value += quote; index++; continue; }
        return value ? { value, end: index + 1 } : null;
      }
      return null;
    }
    let end = start;
    while (end < description.length) {
      const code = description.codePointAt(end);
      const width = code > 0xffff ? 2 : 1;
      if (!identifier.test(description.slice(end, end + width))) break;
      end += width;
    }
    return end > start && !/[`"]/.test(description[end] || "") ? { value: description.slice(start, end), end } : null;
  };

  for (let dot = description.indexOf("."); dot >= 0; dot = description.indexOf(".", dot + 1)) {
    const database = left(dot), table = right(dot + 1);
    if (database && table) return { database: database.value, name: table.value };
  }
  return null;
}
