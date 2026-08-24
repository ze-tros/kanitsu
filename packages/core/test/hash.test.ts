import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { imageIdFor } from '../src/hash';

describe('imageIdFor', () => {
  test('normalizes path separators', () => {
    assert.equal(imageIdFor('a\\b/c.jpg'), imageIdFor('a/b/c.jpg'));
  });

  test('uses the normalized relPath so distinct images never collide', () => {
    assert.equal(imageIdFor('a/b.jpg'), 'img:a/b.jpg');
    assert.notEqual(imageIdFor('a/b.jpg'), imageIdFor('a/c.jpg'));
    assert.notEqual(
      imageIdFor('Attack_on_Titan/Vol.01/p001.jpg'),
      imageIdFor('Attack_on_Titan/Vol.01/p002.jpg'),
    );
  });
});
