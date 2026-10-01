// PDF coordinates keep the same line at the top even when the page width changes.
export function capturePosition(viewer) {
  if (!viewer?.pdfDocument) return null;
  const container = viewer.container, bounds = container.getBoundingClientRect();
  let index = viewer.currentPageNumber - 1;
  // PDF.js's current page can be the largest visible page rather than the first.
  while (index > 0 && viewer.getPageView(index - 1).div.getBoundingClientRect().bottom > bounds.top + 1) index--;
  while (index < viewer.pagesCount - 1 && viewer.getPageView(index).div.getBoundingClientRect().bottom <= bounds.top + 1) index++;
  const page = viewer.getPageView(index), rect = page.div.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, bounds.left + container.clientWidth / 2 - rect.left));
  const y = Math.max(0, Math.min(rect.height, bounds.top - rect.top));
  const [pdfX, pdfY] = page.viewport.convertToPdfPoint(x, y);
  return {page: index + 1, x: pdfX, y: pdfY, offset: Math.max(0, rect.top - bounds.top),
    scale: viewer.currentScaleValue === 'page-width' ? 'page-width' : viewer.currentScale};
}

export function validPosition(position, pages) {
  if (!position || typeof position !== 'object') return {page: 1, scale: 'page-width'};
  const page = Math.max(1, Math.min(pages, Math.floor(Number(position.page) || 1)));
  const result = {page, scale: position.scale === 'page-width' ? 'page-width' :
    Number.isFinite(position.scale) ? Math.max(.1, Math.min(4, position.scale)) : 'page-width'};
  if (Number.isFinite(position.x) && Number.isFinite(position.y)) {
    result.x = position.x; result.y = position.y;
    result.offset = Math.max(0, Math.min(80, Number(position.offset) || 0));
  }
  return result;
}

export function restorePosition(viewer, position, {scale = true} = {}) {
  if (!viewer?.pdfDocument) return;
  const point = validPosition(position, viewer.pagesCount);
  if (scale) viewer.currentScaleValue = point.scale;
  viewer.currentPageNumber = point.page;
  if (!Number.isFinite(point.x)) return;
  const container = viewer.container, bounds = container.getBoundingClientRect();
  const page = viewer.getPageView(point.page - 1), rect = page.div.getBoundingClientRect();
  const [x, y] = page.viewport.convertToViewportPoint(point.x, point.y);
  container.scrollTop += rect.top - bounds.top + y - point.offset;
  container.scrollLeft += rect.left - bounds.left + x - container.clientWidth / 2;
}

export function positionHash(id, point) {
  const query = new URLSearchParams();
  if (Number.isFinite(point.x) && Number.isFinite(point.y)) {
    query.set('x', point.x.toFixed(2)); query.set('y', point.y.toFixed(2));
  }
  query.set('z', point.scale === 'page-width' ? 'width' : String(Number(point.scale).toFixed(3)));
  return `read/${id}/${point.page}?${query}`;
}

export function parseRoute(hash, catalog) {
  const match = hash.match(/^#read\/([a-z0-9-]+)(?:\/(\d+))?(?:\?([^#]*))?$/);
  const item = match && catalog.find(x => x.id === match[1]);
  if (!item) return null;
  const query = new URLSearchParams(match[3]);
  let position = null;
  if (match[2]) {
    position = {page: Number(match[2]), scale: 'page-width'};
    if (query.has('x') && query.has('y')) {
      position.x = Number(query.get('x')); position.y = Number(query.get('y'));
    }
    if (query.has('z') && query.get('z') !== 'width') position.scale = Number(query.get('z'));
  }
  return {item, position: position && validPosition(position, item.pages), query: query.get('q') || ''};
}
