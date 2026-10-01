import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validPosition, positionHash, parseRoute} from './reading-state.mjs';
import {searchPages} from './search.mjs';

test('old page-only storage, invalid links and zoom limits remain usable', () => {
  assert.deepEqual(validPosition({page: 7}, 20), {page: 7, scale: 'page-width'});
  assert.equal(validPosition({page: -4, scale: 100}, 20).scale, 4);
  assert.equal(validPosition({page: 500, scale: NaN}, 20).page, 20);
  const catalog = [{id: 'logic-a', pages: 20}];
  const point = {page: 9, x: 200.23, y: 123.45, scale: 1.375};
  assert.deepEqual(parseRoute('#' + positionHash('logic-a', point), catalog).position, {...point, offset: 0});
  assert.equal(parseRoute('#read/unknown/2', catalog), null);
  assert.equal(parseRoute('#read/logic-a', catalog).position, null);
});

test('full text search combines words, handles ё and limits rendered results', () => {
  const pages = [{id: 'a', page: 2, text: 'Теорема о решётках и полноте'}, {id: 'b', page: 8, text: 'Теорема'}];
  const result = searchPages(pages, 'РЕШЕТКАХ полноте', new Set(['a']));
  assert.equal(result.total, 1); assert.equal(result.results[0].page, 2);
  assert.equal(searchPages(pages, 'теорема', new Set(['a', 'b']), 1).total, 2);
  assert.equal(searchPages(pages, 'теорема', new Set(['a', 'b']), 1).results.length, 1);
});
