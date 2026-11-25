# 作家助手（authorwrite）直连桥 · 逆向记录

> 抓取对象：`作家助手 Linux X64 deb`，版本 **5.24.0**（`authorwrite_5.24.0_amd64.deb`，2026-10-22 打包）。
> 下载入口来自官网 `https://zuojia.write.qq.com/` 的 `data-app-key="linux_X64-deb"` 按钮，
> 实际下载地址由 `GET https://write.qq.com/ccauthorweb/desk/author/getApk?downType=linux_X64-deb&sign=md5(timestamp+appKey)&timestamp=<unix>` 返回。
> 客户端是 Electron 应用，业务代码在 `resources/app/authorwrite_5.24.0.asar`（`@electron/asar` 可解）。

## 1. 通信层（已用代码复现）

```
POST/GET https://pcwrite.yuewen.com<path>
Cookie:       登录态（含 pubtoken）
x-token:      cookie 里 pubtoken 的值
ptfrom:       authorwrite
d1:           设备序列号加密串（见 §2）
timestamp:    毫秒时间戳
credentials:  include
Content-Type: application/x-www-form-urlencoded
```

客户端源码位置：`out/renderer/assets/log-jml4EDdp.js`（请求封装 `qe`）、`http-D53_g-1R.js`（业务接口）。

```js
// 客户端里的请求头（节选）
headers: { ...i, ...s, "x-token": De, credentials: "include", d1: f, timestamp: Date.now(), ptfrom: "authorwrite" }
// De = cookieGet({name:"pubtoken"}).value
```

## 2. d1 设备序列号算法（已验证）

主进程 `out/main/index.js`：

```js
ipcMain.handle("encryptString", (e, data) => {
  const key = "lT8yjkdQO0EGxeEIl1dr";
  const key1 = md5(key).slice(8, 24);
  const cipher = createCipheriv("aes-128-ecb", key1, "");
  return cipher.update(data, "binary", "base64") + cipher.final("base64");
});
// 序列号来源：本机第一块有效网卡 MAC；明文形如 `aw|<mac>|`
```

本项目的等价实现与测试向量（`src/integrations/zuojia/client.ts::encryptSerial`）：

| 明文 | 结果 |
| --- | --- |
| `aw|aa:bb:cc:dd:ee:ff|` | `KcQtcGWtgDEB6FoX817NxsYO/ln+mpsakorzUZXb6jU=` |
| `aw|00000000-0000-4000-8000-000000000001|` | `FNpCH4YFQ2Z4DR7ZJQQZ66ud1gYVIuswBGryd8zZzGci1D3hMGnjLOCNxNDPZcBP` |

## 3. 用到的接口

| 用途 | 方法 | 路径 | 关键参数 |
| --- | --- | --- | --- |
| 当前作者 | GET | `/ccauthorweb/desk/author/getauthorinfo` | — |
| 作品列表 | GET | `/ccauthorweb/desk/book/getNovelsV2` | 返回 `novelList[].CBID/title/personalNovel` |
| 建书站点 | GET | `/ccauthorweb/novel/getFreeTypeSiteNewV2` | 返回男生/女生/新媒体站点 |
| 建书分类 | GET | `/ccauthorweb/novel/getInfoWhenNewNovel` | `site`；返回分类和子分类 |
| **创建作品** | POST | `/ccauthorweb/novel/createnovel` | `site`、`categoryid`、`subcategoryid`、`title`、`intro`；返回 `cbid` |
| 卷+章列表 | GET | `/ccauthorweb/desk/chapter/getVolumeChapters` | `CBID`、`showVolumeNumber=-1` |
| 单章正文 | GET | `/ccauthorweb/desk/chapter/getChapter` | `CBID`、`CCID` |
| **存草稿/新建章** | POST | `/ccauthorweb/desk/chapter/saveChapter` | `CBID`,`CCID`(新建传 `-1`),`CVIDSelect`,`chapterTypeSelect=1`,`chaptertitle`,`content`,`type=add\|update`,`_token`(=pubtoken),`reqid` |
| 发布章节 | POST | `/ccauthorweb/desk/chapter/publishChapter` | 同上再加 `booktitle`,`chapterword`,`status`,`vipflag`,`enterAudit` |
| 卷管理 | POST | `/ccauthorweb/desk/volume/volumeManageSubmit` | `CBID`,`type`,`CVID`,`volumename` |

错误约定：`returnCode === 2000` 为成功；`4001` 表示登录态失效（需重新登录续期）；其余 `returnMsg` 直接展示。

请求体是 `URLSearchParams` 序列化后再 `.replaceAll("+", "%20")`（客户端原样这么写），本项目复刻了这一点，
因为正文里出现 `+` 时若编码不一致，服务端会收到空格。

## 4. 登录 / 边界

- 登录已收进工作台：`src/integrations/zuojia/session.ts` 管理登录任务，`POST /api/zuojia/login` 启动，
  `GET /api/zuojia/login` 轮询，`GET /api/zuojia/qr` 返回二维码；「递交」页直接完成扫码。
- 登录成功后立即更新服务内存配置并写回 `zuojia.token / cookie`，不需要重启或手改 JSON。
- 「递交」页已把建书收进工作台：登录后可点「在工作台创建远端作品」，选择站点/分类、填书名和简介；
  创建成功后自动把返回的 `cbid` 绑定到当前本地书，不需要先去客户端或网页手动建书。
  对应接口是 `GET /api/zuojia/create-options` 和 `POST /api/books/:id/zuojia/create`。
- 不做发布按钮的自动化：默认 `allowPublish=false`，只写草稿；发布需显式打开。
- 客户端升级后若接口变动，按上表路径在 asar 里重新 `grep` 同名 endpoint 即可核对。

## 5. 复现命令

```bash
# 解包客户端
dpkg-deb -x authorwrite_5.24.0_amd64.deb deb
npx @electron/asar extract 'deb/opt/作家助手/resources/app/authorwrite_5.24.0.asar' /tmp/aw
grep -aoE '"/(cc)?authorweb/[a-z]+/[a-zA-Z]+' /tmp/aw/out/renderer/assets/*.js | sort -u
```


---

# 原生登录（不装作家助手）

工作台「递交」页和 `zuojia-login` 都复用同一登录模块：浏览器打开阅文作家专区登录页，抓微信扫码二维码，
扫码后自动把 cookie（pubtoken/ywkey）写进项目配置，之后直连 `pcwrite.yuewen.com` 推送草稿。

```bash
cd draftvein
pnpm start                                   # 推荐：打开「递交」页点扫码登录
./scripts/run-bird.sh zuojia-login          # 默认等 300s，二维码存 ~/.draftvein/zuojia-qr.jpg
./scripts/run-bird.sh zuojia-login --timeout 600 --qr /tmp/qr.png
./scripts/run-bird.sh zuojia                # 看登录态与远端作品
./scripts/run-bird.sh push --book 1 --cb 123456   # 推送草稿（默认不发布）
```

说明：

- 二维码是微信 `open.weixin.qq.com/connect/qrcode/<uuid>` 的原图（JPEG），直接抓图，不截屏。
- 工作台 UI 会在 `starting → waiting_scan → connected/failed` 之间轮询，并把二维码直接显示在页面里。
- 也支持账号密码：`--user 手机号 --pass 密码`（可能触发滑块，不保证）。
- 登录结果写 `~/.draftvein/config.json` 的 `zuojia.token / zuojia.cookie`（权限 600），
  之后 `push` 直接复用，不用再登。
- `x-token` 取 `pubtoken`，没有就退回 `ywkey`；设备串 `d1` 仍按原客户端算法生成。
- 默认只存草稿（`allowPublish=false`），要发布得显式改配置。
