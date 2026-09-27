import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  baseNameOfRelPath,
  canonicalizeRelPath,
  joinRelPath,
  nameKey,
  normalizeRelPath,
  parentRelPath,
} from '../src/path';

describe('normalizeRelPath', () => {
  test('归一化分隔符、压缩重复斜杠并去除首尾斜杠', () => {
    assert.equal(normalizeRelPath('a/b/c'), 'a/b/c');
    assert.equal(normalizeRelPath('a\\\\b\\\\c'), 'a/b/c');
    assert.equal(normalizeRelPath('a//b///c'), 'a/b/c');
    assert.equal(normalizeRelPath('/a/b/'), 'a/b');
    assert.equal(normalizeRelPath(''), '');
  });
});

describe('canonicalizeRelPath', () => {
  test('消解单级与多级 .. 与 .', () => {
    assert.equal(canonicalizeRelPath('a/../b'), 'b');
    assert.equal(canonicalizeRelPath('a/b/../../c'), 'c');
    assert.equal(canonicalizeRelPath('a/./b/./c'), 'a/b/c');
    assert.equal(canonicalizeRelPath('a/..'), '');
  });

  test('越界 .. 抛错（含连续多级）', () => {
    assert.throws(() => canonicalizeRelPath('..'), /路径越界/);
    assert.throws(() => canonicalizeRelPath('../../x.jpg'), /路径越界/);
    assert.throws(() => canonicalizeRelPath('a/../../b.jpg'), /路径越界/);
    assert.throws(() => canonicalizeRelPath('a/b/../../../c'), /路径越界/);
  });

  test('反斜杠与正斜杠混用', () => {
    assert.equal(canonicalizeRelPath('a\\\\b/../c'), 'a/c');
    assert.equal(canonicalizeRelPath('\\\\a\\\\..\\\\b'), 'b');
  });

  test('空串归一为库根', () => {
    assert.equal(canonicalizeRelPath(''), '');
    assert.equal(canonicalizeRelPath('.'), '');
    assert.equal(canonicalizeRelPath('./'), '');
  });

  test('超长单段原样保留（长度上限由平台层负责）', () => {
    const long = 'x'.repeat(300) + '.jpg';
    assert.equal(canonicalizeRelPath(`a/${long}`), `a/${long}`);
  });

  test('普通路径不受影响', () => {
    assert.equal(canonicalizeRelPath('MangaA/Vol.01/p001.jpg'), 'MangaA/Vol.01/p001.jpg');
  });
});

describe('joinRelPath / parentRelPath / baseNameOfRelPath', () => {
  test('joinRelPath 跳过空段', () => {
    assert.equal(joinRelPath('', 'a', 'b.jpg'), 'a/b.jpg');
    assert.equal(joinRelPath('a', '', 'b.jpg'), 'a/b.jpg');
    assert.equal(joinRelPath('a', 'b', ''), 'a/b');
  });

  test('parentRelPath 与 baseNameOfRelPath 互补', () => {
    assert.equal(parentRelPath('a/b/c.jpg'), 'a/b');
    assert.equal(parentRelPath('c.jpg'), '');
    assert.equal(parentRelPath(''), '');
    assert.equal(baseNameOfRelPath('a/b/c.jpg'), 'c.jpg');
    assert.equal(baseNameOfRelPath('c.jpg'), 'c.jpg');
    assert.equal(baseNameOfRelPath(''), '');
  });
});

describe('nameKey', () => {
  test('NFD 与 NFC 归一到同一键', () => {
    const nfc = 'café.jpg';
    const nfd = 'cafe\u0301.jpg';
    assert.notEqual(nfc, nfd);
    assert.equal(nameKey(nfc), nameKey(nfd));
  });
});
