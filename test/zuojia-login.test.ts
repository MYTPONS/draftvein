import test from 'node:test';
import assert from 'node:assert/strict';
import { loginSessionFromCookies } from '../src/integrations/zuojia/login.ts';

test('只有 ywkey 不能当作作家助手登录成功', () => {
  const session = loginSessionFromCookies([
    { name: 'ywkey', value: 'short-ywkey', domain: '.yuewen.com' },
    { name: 'ywguid', value: 'author-guid', domain: '.yuewen.com' },
  ]);
  assert.equal(session.ok, false);
  assert.equal(session.token, '');
  assert.match(session.cookie, /ywkey=short-ywkey/);
});

test('拿到 pubtoken 后使用 pubtoken 作为 x-token，并去掉重复 cookie 名', () => {
  const session = loginSessionFromCookies([
    { name: 'ywkey', value: 'passport-key', domain: '.yuewen.com' },
    { name: 'pubtoken', value: 'pub-token', domain: '.write.qq.com' },
    { name: 'pubtoken', value: 'pub-token', domain: '.yuewen.com' },
  ]);
  assert.equal(session.ok, true);
  assert.equal(session.token, 'pub-token');
  assert.equal(session.cookie, 'ywkey=passport-key; pubtoken=pub-token');
});
