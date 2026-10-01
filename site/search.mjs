export const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е');

export function searchPages(pages, query, ids, limit = 80) {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return {results: [], total: 0};
  const results = []; let total = 0;
  for (const page of pages) {
    if (!ids.has(page.id)) continue;
    const text = normalize(page.text);
    if (!terms.every(term => text.includes(term))) continue;
    total++;
    if (results.length >= limit) continue;
    const start = Math.max(0, text.indexOf(terms[0]) - 65);
    const snippet = `${start ? '…' : ''}${page.text.slice(start, start + 230)}${start + 230 < page.text.length ? '…' : ''}`;
    results.push({...page, snippet});
  }
  return {results, total};
}
