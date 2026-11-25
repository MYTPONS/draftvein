import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ZuojiaClient, ZuojiaError, encryptSerial, resolveSerial } from '../src/integrations/zuojia/client.ts';
import { makeClient } from '../src/integrations/zuojia/push.ts';

test('d1 序列号加密与客户端 AES-128-ECB 一致', () => {
  assert.equal(encryptSerial('aa:bb:cc:dd:ee:ff'), 'KcQtcGWtgDEB6FoX817NxsYO/ln+mpsakorzUZXb6jU=');
  assert.equal(encryptSerial('00000000-0000-4000-8000-000000000001'), 'FNpCH4YFQ2Z4DR7ZJQQZ66ud1gYVIuswBGryd8zZzGci1D3hMGnjLOCNxNDPZcBP');
});

test('resolveSerial 优先使用配置值', () => {
  assert.equal(resolveSerial('de:ad:be:ef:00:01'), 'de:ad:be:ef:00:01');
  assert.ok(resolveSerial().length >= 8);
});

function fakeFetch(handler: (url: string, init: any) => any) {
  const calls: { url: string; init: any }[] = [];
  const impl = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const out = handler(String(url), init);
    return new Response(JSON.stringify(out.body), { status: out.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('未登录时把 4001 转成可读错误', async () => {
  const { impl } = fakeFetch(() => ({ body: { returnCode: 4001, returnMsg: '登录态失效，请重新登录' } }));
  const c = new ZuojiaClient({ token: 't', fetchImpl: impl });
  await assert.rejects(() => c.me(), (err: any) => {
    assert.ok(err instanceof ZuojiaError);
    assert.equal(String(err.returnCode), '4001');
    assert.match(err.message, /登录态失效/);
    return true;
  });
});

test('作品列表映射成统一结构', async () => {
  const { impl, calls } = fakeFetch(() => ({
    body: { returnCode: 2000, result: { novelList: [{ CBID: 'CB1', title: '旧城', personalNovel: true, words: 1234 }] } },
  }));
  const c = new ZuojiaClient({ token: 't', fetchImpl: impl });
  const books = await c.books();
  assert.deepEqual(books, [{ cbid: 'CB1', bid: '', title: '旧城', personalNovel: true, words: 1234 }]);
  assert.equal(calls[0].url, 'https://pcwrite.yuewen.com/ccauthorweb/desk/book/getNovelsV2');
  assert.equal(calls[0].init.headers['x-token'], 't');
  assert.equal(calls[0].init.headers.ptfrom, 'authorwrite');
  assert.ok(calls[0].init.headers.d1.length > 10);
});

test('存草稿：CCID=-1 + type=add，表单编码且 + 不残留', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { returnCode: 2000, result: { CCID: '9001' } } }));
  const c = new ZuojiaClient({ token: 'pubtoken', fetchImpl: impl });
  const r = await c.saveChapter({ cbid: 'CB1', title: '第1章 名单', content: '他把名单折成四折。+号测试&符号' });
  assert.equal(r.CCID, '9001');
  const body = String(calls[0].init.body);
  const params = new URLSearchParams(body);
  assert.equal(params.get('CBID'), 'CB1');
  assert.equal(params.get('CCID'), '-1');
  assert.equal(params.get('type'), 'add');
  assert.equal(params.get('_token'), 'pubtoken');
  assert.equal(params.get('content'), '他把名单折成四折。+号测试&符号');
  assert.ok(!body.includes('+'), '+ 号必须编码成 %20');
});

test('更新已有章节走 update', async () => {
  const { impl, calls } = fakeFetch(() => ({ body: { returnCode: 2000, result: {} } }));
  const c = new ZuojiaClient({ token: 't', fetchImpl: impl });
  await c.saveChapter({ cbid: 'CB1', ccid: '77', title: 't', content: 'c' });
  assert.equal(new URLSearchParams(String(calls[0].init.body)).get('type'), 'update');
});

test('业务失败码抛错而不是静默返回', async () => {
  const { impl } = fakeFetch(() => ({ body: { returnCode: 1120008, returnMsg: '请勿频繁修改' } }));
  const c = new ZuojiaClient({ token: 't', fetchImpl: impl });
  await assert.rejects(() => c.saveChapter({ cbid: 'C', title: 't', content: 'c' }), /请勿频繁修改/);
});

test('项目配置里的完整 cookie 会自动带给作家助手客户端', () => {
  const c = makeClient({
    zuojia: { token: 'pubtoken', cookie: 'pubtoken=pubtoken; ywkey=yw', serial: '', books: {}, allowPublish: false, baseUrl: 'https://pcwrite.example.test' },
  } as any);
  assert.match(c.headers().cookie || '', /ywkey=yw/);
});

test('读取发布站点与分类，创建作品使用作家专区网页协议', async () => {
  const { impl, calls } = fakeFetch((url) => {
    if (url.includes('/ccauthorweb/novel/getFreeTypeSiteNewV2')) {
      return {
        body: {
          returnCode: 2000,
          result: {
            maleList: [{ name: 'QQ阅读', desc: '阅读平台', sites: [{ sexSite: '男生', site: 1, freeType: 1, showSiteName: 'QQ阅读-男生' }] }],
            femaleList: [{ name: '起点', desc: '女生平台', sites: [{ sexSite: '女生', site: 3, freeType: 2, showSiteName: '起点-女生' }] }],
            newMediaList: [],
          },
        },
      };
    }
    if (url.includes('/ccauthorweb/novel/getInfoWhenNewNovel')) {
      return {
        body: {
          returnCode: 2000,
          result: {
            categoryVos: [
              {
                categoryid: '20019',
                categoryname: '悬疑',
                categorydesc: '悬疑分类',
                subcategoryList: [
                  { subcategoryid: '20020', subcategoryname: '社会悬疑', subcategorydesc: '' },
                  { subcategoryid: '20021', subcategoryname: '推理', subcategorydesc: '' },
                ],
              },
            ],
          },
        },
      };
    }
    if (url.includes('/ccauthorweb/novel/getnovelgrouplist')) {
      return {
        body: {
          returnCode: 2000,
          result: {
            lastNovelGroup: '8',
            novelGroupVOS: [{ novelgroup: '8', novelgroupname: '第六编辑组' }],
          },
        },
      };
    }
    if (url.endsWith('/ccauthorweb/novel/createnovel')) {
      return { body: { returnCode: 2000, result: { cbid: 'CB-NEW', coverurl: 'cover.jpg', words: 0 } } };
    }
    throw new Error(`unexpected url ${url}`);
  });
  const c = new ZuojiaClient({ token: 't', fetchImpl: impl });

  const sites = await c.sites();
  assert.deepEqual(sites, [
    { site: 1, name: 'QQ阅读-男生', platform: 'QQ阅读', sexSite: '男生', freeType: 1 },
    { site: 3, name: '起点-女生', platform: '起点', sexSite: '女生', freeType: 2 },
  ]);

  const categories = await c.newNovelInfo(1);
  assert.deepEqual(categories, [
    {
      categoryid: '20019',
      categoryname: '悬疑',
      categorydesc: '悬疑分类',
      subcategories: [
        { subcategoryid: '20020', subcategoryname: '社会悬疑', subcategorydesc: '' },
        { subcategoryid: '20021', subcategoryname: '推理', subcategorydesc: '' },
      ],
    },
  ]);

  const groups = await c.novelGroups({ site: 1, categoryid: '20019', subcategoryid: '20020' });
  assert.deepEqual(groups, {
    lastNovelGroup: '8',
    groups: [{ novelgroup: '8', novelgroupname: '第六编辑组' }],
  });

  const created = await c.createNovel({ site: 1, categoryid: '20019', subcategoryid: '20020', title: ' 新书 ', intro: '', novelgroup: '8' });
  assert.equal(created.cbid, 'CB-NEW');
  assert.equal(calls.at(-1)?.url, 'https://pcwrite.yuewen.com/ccauthorweb/novel/createnovel');
  assert.equal(calls.at(-1)?.init.method, 'POST');
  const params = new URLSearchParams(String(calls.at(-1)?.init.body));
  assert.equal(params.get('site'), '1');
  assert.equal(params.get('categoryid'), '20019');
  assert.equal(params.get('subcategoryid'), '20020');
  assert.equal(params.get('title'), '新书');
  assert.equal(params.get('intro'), '来阅文旗下网站阅读我的更多作品吧！');
  assert.equal(params.get('canduplicationtitle'), '0');
  assert.equal(params.get('novelgroup'), '8');
  assert.equal(params.get('isprecollection'), '0');
  assert.equal(params.get('artidx'), '0');
  assert.equal(params.get('artextidx'), '0');
  assert.equal(params.get('anonymousId'), '');
  assert.equal(params.get('anonymousName'), '');
});

test('创建作品拒绝超过网页允许长度的作品名', async () => {
  const { impl } = fakeFetch(() => ({ body: { returnCode: 2000, result: { cbid: 'CB' } } }));
  const c = new ZuojiaClient({ token: 't', fetchImpl: impl });
  await assert.rejects(
    () => c.createNovel({ site: 1, categoryid: 'c', subcategoryid: 's', title: '这是一个长度明显超过十五个字的作品名字' }),
    /最多 15 个字/,
  );
});

test('创建作品响应兼容 CBID/BID 字段，无作品 ID 时明确失败', async () => {
  const upper = fakeFetch(() => ({ body: { returnCode: 2000, result: { CBID: 'CB-UPPER' } } }));
  const upperClient = new ZuojiaClient({ token: 't', fetchImpl: upper.impl });
  assert.equal((await upperClient.createNovel({ site: 1, categoryid: 'c', subcategoryid: 's', title: '书' })).cbid, 'CB-UPPER');

  const bid = fakeFetch(() => ({ body: { returnCode: 2000, result: { BID: 'BID-1' } } }));
  const bidClient = new ZuojiaClient({ token: 't', fetchImpl: bid.impl });
  assert.equal((await bidClient.createNovel({ site: 1, categoryid: 'c', subcategoryid: 's', title: '书' })).cbid, 'BID-1');

  const missing = fakeFetch(() => ({ body: { returnCode: 2000, result: {} } }));
  const missingClient = new ZuojiaClient({ token: 't', fetchImpl: missing.impl });
  await assert.rejects(
    () => missingClient.createNovel({ site: 1, categoryid: 'c', subcategoryid: 's', title: '书' }),
    /没有返回作品 ID/,
  );
});

