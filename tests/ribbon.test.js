import test from 'node:test';
import assert from 'node:assert/strict';

/*
 * The ribbon maths lives in the service worker, which cannot be imported here
 * because it calls chrome.* at module scope. The two functions are duplicated
 * below verbatim; this test exists to pin the invariant that binds them.
 *
 * That invariant is not decorative. When cellFor and the capacity formula
 * disagree, some cells receive more segments than they claim to hold while
 * their neighbours never fill, and those neighbours sit on the amber
 * "in flight" colour for the entire download.
 */

function cellFor(index, total, cells) {
  return Math.min(cells - 1, Math.floor((index * cells) / total));
}

function ribbonCapacity(total, cells) {
  const firstIndexIn = (cell) => Math.floor((cell * total + cells - 1) / cells);
  return Array.from({ length: cells }, (_, cell) => firstIndexIn(cell + 1) - firstIndexIn(cell));
}

/** Count how many indices actually land in each cell. */
function observedCounts(total, cells) {
  const counts = new Array(cells).fill(0);
  for (let index = 0; index < total; index++) counts[cellFor(index, total, cells)]++;
  return counts;
}

const SHAPES = [
  [1140, 48], // the case that exposed the original bug
  [330, 48],
  [4001, 48],
  [96, 48],
  [48, 48],
  [49, 48],
  [47, 47],
  [1, 1],
  [7, 3],
  [100_000, 48],
];

for (const [total, cells] of SHAPES) {
  test(`capacity matches reality for ${total} segments over ${cells} cells`, () => {
    assert.deepEqual(ribbonCapacity(total, cells), observedCounts(total, cells));
  });

  test(`every segment of ${total} lands in a real cell (${cells} cells)`, () => {
    for (const index of [0, 1, Math.floor(total / 2), total - 1]) {
      const cell = cellFor(index, total, cells);
      assert.ok(cell >= 0 && cell < cells, `index ${index} mapped to cell ${cell}`);
    }
  });

  test(`capacities of ${total} over ${cells} cells sum to the total`, () => {
    const sum = ribbonCapacity(total, cells).reduce((a, b) => a + b, 0);
    assert.equal(sum, total);
  });
}

test('a fully downloaded stream fills every cell to capacity, none left amber', () => {
  const total = 1140;
  const cells = 48;
  const capacity = ribbonCapacity(total, cells);
  const done = new Array(cells).fill(0);

  for (let index = 0; index < total; index++) done[cellFor(index, total, cells)]++;

  const stuck = done
    .map((count, cell) => ({ cell, count, capacity: capacity[cell] }))
    .filter((entry) => entry.count !== entry.capacity);

  assert.deepEqual(stuck, [], 'no cell should end over or under its capacity');
});

test('the old formula is what it replaced, and it really was wrong', () => {
  const total = 1140;
  const cells = 48;
  const broken = Array.from(
    { length: cells },
    (_, cell) => Math.floor(((cell + 1) * total) / cells) - Math.floor((cell * total) / cells),
  );

  assert.notDeepEqual(broken, observedCounts(total, cells));
  assert.equal(broken[0], 23);
  assert.equal(cellFor(23, total, cells), 0, 'index 23 lands in cell 0, which claimed only 23');
});
