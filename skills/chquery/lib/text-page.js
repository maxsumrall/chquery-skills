const highSurrogate = code => code >= 0xD800 && code <= 0xDBFF;
const lowSurrogate = code => code >= 0xDC00 && code <= 0xDFFF;

export function textPage(text, requested = 0, pageSize = 8192) {
  const starts = [0];
  while (starts.at(-1) < text.length) {
    let end = Math.min(text.length, starts.at(-1) + pageSize);
    if (end < text.length && highSurrogate(text.charCodeAt(end - 1)) && lowSurrogate(text.charCodeAt(end))) end++;
    starts.push(end);
  }
  const pages = Math.max(1, starts.length - 1);
  const page = requested === -1 ? pages - 1 : Math.max(0, Math.min(Number(requested) || 0, pages - 1));
  return { text: text.slice(starts[page], starts[page + 1]), page, pages, characters: text.length };
}
