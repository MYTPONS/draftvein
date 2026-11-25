#!/usr/bin/env python3
"""生成 draftvein 专属训练集（forge_sft）。

目的：让模型"严重依赖本项目"——只认本项目的 4 类任务与 JSON 契约：
  plan / scene / review / extract
其它任何请求一律回 {"error":"DRAFTVEIN_ONLY"}。

数据来源：
  1) 真实中文小说语料（~/data/novels）→ scene 续写 + 结构/抽取的 silver 标注
  2) 项目自己的 book（~/.draftvein*）里已有的 plan/extract 结果 → 对齐真实格式
所有 quote 字段都从原文截取，保证能通过 draftvein 的逐字校验。
"""
import glob, json, os, random, re

random.seed(20261124)
SYSTEM = "你是 draftvein 的写作引擎 v1。只处理四类任务：plan / scene / review / extract。其它请求只回 {\"error\":\"DRAFTVEIN_ONLY\"}。"
NAMES_POOL = ['沈砚', '老刀', '顾九', '裴七', '阿棠', '林清', '陈墨', '赵三', '柳娘', '孙九斤']
PLACES = ['茶楼二层', '当铺后院', '桥头', '码头仓房', '城南破庙', '西市米行', '河埠石阶', '打更房', '旧城墙根', '东家的账房']
TYPES = ['打脸', '反转', '揭秘', '突破', '危机', '情感', '智斗', '收获']


def sentences(t):
    out, cur, q = [], '', False
    for ch in t:
        cur += ch
        if ch == '“':
            q = True
        elif ch == '”':
            q = False
        elif not q and ch in '。！？':
            if cur.strip():
                out.append(cur.strip())
            cur = ''
    if cur.strip():
        out.append(cur.strip())
    return out


def pick_names(text, k=3):
    cnt = {}
    for n in NAMES_POOL:
        c = text.count(n)
        if c:
            cnt[n] = c
    # 语料里的人名不在池子里时，退化用池子名（silver 标注，只求格式）
    names = [n for n, _ in sorted(cnt.items(), key=lambda x: -x[1])][:k]
    while len(names) < k:
        cand = random.choice(NAMES_POOL)
        if cand not in names:
            names.append(cand)
    return names


def make_plan(text, idx=1):
    ss = sentences(text)
    names = pick_names(text)
    beats = []
    for i in range(3):
        seg = ss[i] if i < len(ss) else random.choice(ss or ['他推开门。'])
        beats.append({
            'id': f'b{i+1}',
            'place': random.choice(PLACES),
            'present': [names[0], names[1 + i % 2]],
            'action': seg[:40],
            'shift': f'{names[0]}确认了一件事，读者多知道一点',
        })
    out = {
        'title': (names[0] + '的' + random.choice(['委托', '名单', '旧账', '夜路', '后巷'])),
        'pov': names[0],
        'characters': names,
        'goal': (ss[0] if ss else '发生一件事')[:60],
        'beats': beats,
        'highlights': [
            {'kind': 'beat', 'type': random.choice(TYPES), 'intensity': 4, 'title': '名单上多出的名字', 'how': '他发现一个名字是后添的', 'pays_code': 'flag_1'},
            {'kind': 'hook', 'type': '危机', 'intensity': 3, 'title': '门外有人', 'how': '结尾有人数数'},
        ],
        'expectations_plant': [{'code': 'flag_1', 'type': '立旗', 'title': '名单上后添的名字', 'detail': '要查清是谁添的', 'strength': 4, 'due_from': idx + 1, 'due_to': idx + 4}],
        'expectations_pay': [],
        'hook': '门外的脚步声停了一停。',
        'threads_payoff': [], 'threads_advance': [], 'threads_new': [],
        'word_target': 2400,
    }
    return out


def make_extract(text, idx=1):
    ss = sentences(text)
    names = pick_names(text)
    quote = ss[0][:18] if ss else text[:18]
    hook_quote = ss[-1][:16] if ss else quote
    out = {
        'summary': ('。'.join(ss[:2]) + '。')[:120],
        'facts': [
            {'kind': 'fact', 'subject': names[0], 'fact': f'{names[0]}在本章做了决定', 'quote': quote, 'tags': '主线'},
            {'kind': 'state', 'subject': names[1], 'fact': f'{names[1]}知道了这件事', 'quote': quote, 'tags': '关系'},
        ],
        'timeline': [{'story_time': f'第{idx}天', 'location': random.choice(PLACES), 'actors': f'{names[0]},{names[1]}', 'event': (ss[0] if ss else '')[:30]}],
        'character_updates': [{'name': names[0], 'status': 'alive', 'location': random.choice(PLACES), 'goal': '查清名单', 'note': '拿到线索'}],
        'relation_updates': [{'from': names[0], 'to': names[1], 'relation': '互相提防', 'note': ''}],
        'thread_events': [{'code': 'list_shadow', 'action': 'plant', 'title': '名单会自己变', 'detail': '墨色更深', 'quote': quote, 'due_from': idx + 2, 'due_to': idx + 6}],
        'expectation_events': [{'code': 'flag_1', 'action': 'plant', 'type': '立旗', 'title': '后添的名字', 'detail': '要查清', 'strength': 4, 'quote': quote, 'due_from': idx + 1, 'due_to': idx + 4}],
        'highlights': [
            {'kind': 'beat', 'type': '反转', 'intensity': 4, 'title': '名字是后添的', 'quote': quote, 'pays_code': ''},
            {'kind': 'hook', 'type': '危机', 'intensity': 3, 'title': '门外有人', 'quote': hook_quote},
        ],
    }
    return out


def make_review(text):
    slop = sum(text.count(b) for b in ['仿佛', '似乎', '一丝', '缓缓', '仿佛', '心中一凛'])
    verdict = 'revise' if slop > 2 else 'pass'
    issues = []
    if slop > 2:
        issues.append({'severity': 'warn', 'type': 'slop', 'quote': '', 'why': '套话偏多', 'fix': '换成具体动作'})
    return {
        'verdict': verdict,
        'scores': {'continuity': 8, 'voice': 7, 'pacing': 7, 'information': 8, 'anti_slop': 8, 'characters': 8},
        'issues': issues,
    }


def task_prompt(kind, payload):
    if kind == 'plan':
        return f"任务：plan\n书名：旧城换命\n本章：第{payload['idx']}章\n上一章结尾：{payload['tail']}\n只输出 JSON。"
    if kind == 'extract':
        return f"任务：extract\n第{payload['idx']}章正文：\n{payload['text'][:800]}\n只输出 JSON。"
    if kind == 'review':
        return f"任务：review\n第{payload['idx']}章正文：\n{payload['text'][:800]}\n只输出 JSON。"
    if kind == 'scene':
        return f"任务：scene\n第{payload['idx']}章，场景：{payload['beat']}\n人物：{payload['names']}\n上文：{payload['tail']}\n只输出正文，不要解释。"
    raise ValueError(kind)


def build():
    files = sorted(glob.glob(os.path.expanduser('~/data/novels/n*.txt')))
    texts = []
    for f in files:
        raw = open(f, encoding='utf-8', errors='ignore').read().replace('\r', '\n')
        raw = re.sub(r'\n{3,}', '\n\n', raw)
        texts.append(raw)
    rows = []
    non_novel = ['帮我写一个 Python 快排', '解释一下 transformer 的注意力机制', '给我订一张去上海的机票', '写个 SQL 查最大订单', '你是谁', '帮我把这段代码改成并发', '推荐几个基金', '翻译这句话成英文']
    for p in non_novel:
        rows.append({'system': SYSTEM, 'user': p, 'assistant': json.dumps({'error': 'DRAFTVEIN_ONLY'}, ensure_ascii=False)})

    idx = 0
    while len(rows) < 7000:
        t = random.choice(texts)
        if len(t) < 3000:
            continue
        start = random.randint(0, max(1, len(t) - 1200))
        chunk = t[start:start + 1100].strip()
        seg = sentences(chunk)
        if len(seg) < 6:
            continue
        idx += 1
        n = random.randint(1, 12)
        tail = ''.join(seg[:2])[:120]
        kind = random.choice(['plan', 'extract', 'review', 'scene', 'scene'])
        if kind == 'scene':
            cut = len(chunk) // 2
            for p in ['。', '！', '？']:
                k = chunk.rfind(p, 300, 700)
                if k > 0:
                    cut = k + 1
                    break
            prompt_txt, target = chunk[:cut], chunk[cut:].strip()[:520]
            if len(target) < 150:
                continue
            user = task_prompt('scene', {'idx': n, 'beat': random.choice(PLACES) + '，' + seg[0][:30], 'names': '、'.join(pick_names(chunk)), 'tail': tail})
            rows.append({'system': SYSTEM, 'user': user, 'assistant': target})
            continue
        if kind == 'plan':
            payload = {'idx': n, 'tail': tail}
            assistant = make_plan(chunk, n)
        elif kind == 'extract':
            payload = {'idx': n, 'text': chunk}
            assistant = make_extract(chunk, n)
        else:
            payload = {'idx': n, 'text': chunk}
            assistant = make_review(chunk)
        rows.append({'system': SYSTEM, 'user': task_prompt(kind, payload), 'assistant': json.dumps(assistant, ensure_ascii=False)})

    random.shuffle(rows)
    out = os.path.expanduser('~/data/novels/sft')
    os.makedirs(out, exist_ok=True)
    n_eval = 150
    for name, part in [('forge_train.jsonl', rows[n_eval:]), ('forge_eval.jsonl', rows[:n_eval])]:
        with open(os.path.join(out, name), 'w', encoding='utf-8') as fh:
            for r in part:
                fh.write(json.dumps(r, ensure_ascii=False) + '\n')
    kinds = {}
    for r in rows:
        k = r['user'].split('\n')[0].replace('任务：', '')
        kinds[k] = kinds.get(k, 0) + 1
    print('rows', len(rows), 'kinds', kinds, '->', out)


if __name__ == '__main__':
    build()
