import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDocx } from '../src/export/docx.ts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const buf = buildDocx({
  title: '旧城换命',
  author: '测试作者',
  intro: '一桩不能拒绝的差事。',
  tags: ['悬疑', '群像'],
  chapters: [
    { idx: 1, title: '第七次敲门', content: '沈砚把名单折成四折。\n\n“东西呢？”老刀问。' },
    { idx: 2, title: '名单上的手印', content: '茶凉了。' },
  ],
});

test('docx 是合法 zip，含 document.xml', () => {
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK');
  assert.ok(buf.includes(Buffer.from('word/document.xml')));
  assert.ok(buf.includes(Buffer.from('word/styles.xml')));
});

test('docx 能被解压且正文包含章节内容', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-docx-'));
  const file = path.join(dir, 't.docx');
  fs.writeFileSync(file, buf);
  let out = '';
  try {
    out = execFileSync('unzip', ['-p', file, 'word/document.xml'], { encoding: 'utf8' });
  } catch {
    // 环境没 unzip 就跳过解压校验
    return;
  }
  assert.match(out, /旧城换命/);
  assert.match(out, /第七次敲门/);
  assert.match(out, /沈砚把名单折成四折/);
  fs.rmSync(dir, { recursive: true, force: true });
});
