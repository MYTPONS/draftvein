/**
 * 作家助手（pcwrite.yuewen.com / authorwrite 客户端）直连。
 *
 * 依据 Linux 客户端 5.24.0 的接口层还原：
 *  - 所有请求打 https://pcwrite.yuewen.com，带 cookie 登录态
 *  - header: x-token = cookie pubtoken 的值；ptfrom: authorwrite；d1 = 设备序列号的加密串
 *  - 表单以 application/x-www-form-urlencoded 提交
 *  - 章节保存 /ccauthorweb/desk/chapter/saveChapter（type=add|update，CCID=-1 为新建）
 *
 * 本模块只做两件事：读远端作品/卷章，把本地章节作为草稿写进去（默认不发布）。
 */
import crypto from 'node:crypto';
import os from 'node:os';

const ENC_KEY = 'lT8yjkdQO0EGxeEIl1dr';

/** 客户端主进程 encryptString 的等价实现：aes-128-ecb(md5(key)[8:24]) */
export function encryptSerial(serial: string): string {
  const key = crypto.createHash('md5').update(ENC_KEY).digest('hex').slice(8, 24);
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key, 'utf8'), null);
  return Buffer.concat([cipher.update(Buffer.from(`aw|${serial}|`, 'utf8')), cipher.final()]).toString('base64');
}

/** d1：优先用配置里的 serial，否则取本机第一块非虚拟网卡 MAC，最后退回随机 UUID */
export function resolveSerial(configured?: string): string {
  if (configured && configured.trim()) return configured.trim();
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const it of list || []) {
      const mac = it.mac;
      if (!mac) continue;
      if (mac.startsWith('00:50:56') || mac === '00:00:00:00:00:00') continue;
      if (it.internal) continue;
      return mac;
    }
  }
  return crypto.randomUUID();
}

export interface ZuojiaOptions {
  baseUrl?: string;
  /** pubtoken，登录后从客户端 cookie 拿 */
  token: string;
  serial?: string;
  /** 额外 cookie，形如 "ywguid=xxx; ywkey=yyy" */
  cookie?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class ZuojiaError extends Error {
  returnCode?: number | string;
  url?: string;
  constructor(message: string, opts: { returnCode?: number | string; url?: string } = {}) {
    super(message);
    this.name = 'ZuojiaError';
    this.returnCode = opts.returnCode;
    this.url = opts.url;
  }
}

export class ZuojiaClient {
  baseUrl: string;
  token: string;
  serial: string;
  cookie: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;

  constructor(opts: ZuojiaOptions) {
    this.baseUrl = (opts.baseUrl || 'https://pcwrite.yuewen.com').replace(/\/$/, '');
    this.token = opts.token || '';
    this.serial = resolveSerial(opts.serial);
    this.cookie = opts.cookie || '';
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json, text/plain, */*',
      'x-token': this.token,
      d1: encryptSerial(this.serial),
      ptfrom: 'authorwrite',
      timestamp: String(Date.now()),
      credentials: 'include',
      origin: 'https://zuojia.write.qq.com',
      referer: 'https://zuojia.write.qq.com/',
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) authorwrite/5.24.0 Chrome/120 Safari/537.36',
    };
    if (this.cookie) h.cookie = this.cookie;
    return h;
  }

  async call(method: 'GET' | 'POST', path: string, params?: Record<string, any>): Promise<any> {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    const body = params ? new URLSearchParams(clean(params)).toString().replace(/\+/g, '%20') : undefined;
    if (method === 'GET' && body) url.search = body;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: this.headers(),
        body: method === 'POST' ? body : undefined,
        signal: ac.signal,
        redirect: 'manual',
      });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ZuojiaError(`返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`, { url: url.toString() });
    }
    const code = data?.returnCode;
    if (code !== 2000 && code !== 1000000) {
      throw new ZuojiaError(String(data?.returnMsg || data?.info || '接口失败'), { returnCode: code, url: url.toString() });
    }
    return data.result ?? data;
  }

  /** 当前登录作者信息；返回 null 代表未登录 */
  async me() {
    return this.call('GET', '/ccauthorweb/desk/author/getauthorinfo');
  }

  /** 作品列表 */
  async books() {
    const r = await this.call('GET', '/ccauthorweb/desk/book/getNovelsV2');
    return (r?.novelList || []).map((b: any) => ({
      cbid: String(b.CBID || b.BID || ''),
      bid: String(b.BID || ''),
      title: b.title || b.name || '',
      personalNovel: Boolean(b.personalNovel),
      words: Number(b.words || b.totalwords || 0),
    }));
  }

  /** 建书页可选的发布站点（网页端与客户端共用） */
  async sites() {
    const r = await this.call('GET', '/ccauthorweb/novel/getFreeTypeSiteNewV2?actarticleidx=0');
    const groups = [
      ...(Array.isArray(r?.maleList) ? r.maleList : []),
      ...(Array.isArray(r?.femaleList) ? r.femaleList : []),
      ...(Array.isArray(r?.newMediaList) ? r.newMediaList : []),
    ];
    return groups.flatMap((group: any) =>
      (Array.isArray(group?.sites) ? group.sites : []).map((item: any) => ({
        site: Number(item.site),
        name: String(item.showSiteName || group.name || item.site || ''),
        platform: String(group.name || ''),
        sexSite: String(item.sexSite || ''),
        freeType: Number(item.freeType || 0),
      })),
    );
  }

  /** 指定站点下的分类与子分类；分类在网页建书页是必选项 */
  async newNovelInfo(site: number) {
    const r = await this.call('GET', `/ccauthorweb/novel/getInfoWhenNewNovel?site=${encodeURIComponent(String(site))}&actarticleidx=0`);
    return (Array.isArray(r?.categoryVos) ? r.categoryVos : []).map((c: any) => ({
      categoryid: String(c.categoryid || ''),
      categoryname: String(c.categoryname || ''),
      categorydesc: String(c.categorydesc || ''),
      subcategories: (Array.isArray(c.subcategoryList) ? c.subcategoryList : []).map((s: any) => ({
        subcategoryid: String(s.subcategoryid || ''),
        subcategoryname: String(s.subcategoryname || ''),
        subcategorydesc: String(s.subcategorydesc || ''),
      })),
    }));
  }

  /** 建书页的编辑组列表；创建作品时带上编辑组更接近网页端流程 */
  async novelGroups(input: { site: number; categoryid: string; subcategoryid: string }) {
    const r = await this.call(
      'GET',
      `/ccauthorweb/novel/getnovelgrouplist?site=${encodeURIComponent(String(input.site))}&categoryid=${encodeURIComponent(
        input.categoryid,
      )}&subcategoryid=${encodeURIComponent(input.subcategoryid)}&t=${Date.now()}`,
    );
    return {
      lastNovelGroup: String(r?.lastNovelGroup || ''),
      groups: (Array.isArray(r?.novelGroupVOS) ? r.novelGroupVOS : []).map((g: any) => ({
        novelgroup: String(g.novelgroup || ''),
        novelgroupname: String(g.novelgroupname || ''),
      })),
    };
  }

  /**
   * 在工作台内创建远端作品。走作家专区网页的 /ccauthorweb/novel/createnovel，
   * 不使用客户端私密作品接口（该接口需要邀请码）。
   */
  async createNovel(input: {
    site: number;
    categoryid?: string;
    subcategoryid?: string;
    title: string;
    intro?: string;
    novelgroup?: string;
    canduplicationtitle?: number | boolean;
    isprecollection?: number | boolean;
    artidx?: number;
    artextidx?: number;
  }) {
    const title = String(input.title || '').trim();
    if (!title) throw new ZuojiaError('作品名不能为空');
    if ([...title].length > 15) throw new ZuojiaError('作品名最多 15 个字');
    if (!Number.isFinite(Number(input.site))) throw new ZuojiaError('发布站点无效');
    const raw = await this.call('POST', '/ccauthorweb/novel/createnovel', {
      site: Number(input.site),
      categoryid: input.categoryid || '',
      subcategoryid: input.subcategoryid || '',
      title,
      canduplicationtitle: input.canduplicationtitle ? 1 : 0,
      intro: String(input.intro || '').trim() || '来阅文旗下网站阅读我的更多作品吧！',
      novelgroup: input.novelgroup || '',
      isprecollection: input.isprecollection ? 1 : 0,
      artidx: input.artidx || 0,
      artextidx: input.artextidx || 0,
      anonymousId: '',
      anonymousName: '',
    });
    const cbid = String(
      (typeof raw === 'string' ? raw : '') || raw?.cbid || raw?.CBID || raw?.bid || raw?.BID || '',
    ).trim();
    if (!cbid) throw new ZuojiaError('创建作品接口没有返回作品 ID');
    return {
      cbid,
      coverurl: String(raw?.coverurl || raw?.coverUrl || ''),
      words: Number(raw?.words || 0),
    };
  }

  /** 卷 + 章列表 */
  async volumes(cbid: string) {
    return this.call('GET', `/ccauthorweb/desk/chapter/getVolumeChapters?CBID=${encodeURIComponent(cbid)}&showVolumeNumber=-1`);
  }

  /** 单章正文 */
  async chapter(cbid: string, ccid: string) {
    return this.call('GET', `/ccauthorweb/desk/chapter/getChapter?CBID=${encodeURIComponent(cbid)}&CCID=${encodeURIComponent(ccid)}`);
  }

  /** 存草稿：ccid 传 -1 表示新建 */
  async saveChapter(input: {
    cbid: string;
    ccid?: string;
    cvid?: string;
    title: string;
    content: string;
    extra?: string;
    sort?: number;
  }) {
    return this.call('POST', '/ccauthorweb/desk/chapter/saveChapter', {
      CBID: input.cbid,
      CCID: input.ccid ?? '-1',
      CVIDSelect: input.cvid ?? '',
      chapterTypeSelect: '1',
      chaptertitle: input.title.slice(0, 35),
      content: input.content,
      chapterextra: input.extra ?? '',
      status: '',
      type: (input.ccid ?? '-1') === '-1' ? 'add' : 'update',
      _token: this.token,
      reqid: crypto.randomUUID(),
      correctIdx: '',
      chapterimportid: '',
      bookRecommds: '',
      createtime: '',
      autoSave: '',
    });
  }

  /** 正式发布（需要作者账号权限；默认不调用） */
  async publishChapter(input: { cbid: string; ccid: string; bookTitle: string; cvid?: string; title: string; content: string; words: number }) {
    return this.call('POST', '/ccauthorweb/desk/chapter/publishChapter', {
      booktitle: input.bookTitle,
      CBID: input.cbid,
      CCID: input.ccid,
      CVID: input.cvid ?? '',
      chaptertitle: input.title,
      content: input.content,
      chapterextra: '',
      chaptertype: '1',
      chapterword: String(input.words),
      type: 'update',
      status: '',
      vipflag: '0',
      _token: this.token,
      reqid: crypto.randomUUID(),
      appMonthTicket: '',
      bookRecommds: '',
      enterAudit: '',
    });
  }
}

function clean(obj: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}
