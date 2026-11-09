import assert from 'node:assert/strict';
import test from 'node:test';
import { navigation, navigationGroups, parseRoute, routeHash } from './app/routes.ts';

test('navigation and deep links keep their existing routes', () => {
  assert.deepEqual(parseRoute(''), { view: 'home' });
  for (const [view] of navigation) assert.deepEqual(parseRoute(routeHash(view)), { view });
  for (const hash of ['#pay/statements', '#pay/hours', '#pay/review', '#expenses/schedule', '#expenses/activity', '#expenses/plan', '#investments/accounts', '#documents/imports', '#documents/files', '#simulations/compare', '#simulations/setup', '#simulations/review']) {
    const [view, section] = hash.slice(1).split('/');
    assert.deepEqual(parseRoute(hash), { view, section });
  }
  assert.deepEqual(navigationGroups.flatMap(group => group.views).sort(), navigation.map(([view]) => view).sort());
});

test('unknown pages and sections cannot route into another workspace', () => {
  for (const hash of ['#unknown', '#home/review', '#debts/setup', '#pay/accounts', '#documents/files/extra', '#/files', '#home//extra']) assert.equal(parseRoute(hash), null);
});

test('record links encode identifiers and retain the planner setup shortcut', () => {
  const hash = routeHash('simulations', undefined, 'setup:pay & benefits');
  assert.equal(hash, '#simulations/setup?record=setup%3Apay%20%26%20benefits');
  assert.deepEqual(parseRoute(hash), { view: 'simulations', section: 'setup' });
  assert.equal(new URLSearchParams(hash.split('?')[1]).get('record'), 'setup:pay & benefits');
});
