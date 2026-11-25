#!/usr/bin/env python3
"""novel-forge 专属服务层（把模型"绑死"在本项目契约上）。

思路：不指望小模型自己吐合法 JSON，改由服务层掌握 schema：
  1) 按 SYSTEM 里的"任务：plan|extract|review|scene"分流；
  2) JSON 任务只让模型输出 `键: 值` 的行（这比 JSON 好写得多）；
  3) 服务层解析这些行，按 novel-forge 的固定 schema 组装 JSON；
  4) 引用类字段（quote）逐字校验：原文里找不到就丢掉/替换成原文句子；
  5) 缺字段用确定性兜底补全 → 永远返回 schema 合法的 JSON。

用法：
  python serve_forge.py --model ~/models/forge-1.5b/merged --port 8095
"""
import argparse, json, os, re, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

ap = argparse.ArgumentParser()
ap.add_argument('--model', required=True)
ap.add_argument('--port', type=int, default=8095)
ap.add_argument('--host', default='127.0.0.1')
ap.add_argument('--threads', type=int, default=20)
ap.add_argument('--max-new', type=int, default=420)
a = ap.parse_args()
torch.set_num_threads(a.threads)
tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32, trust_remote_code=True, attn_implementation='sdpa')
model.eval()
LOCK = threading.Lock()
STATS = {'plan': 0, 'extract': 0, 'review': 0, 'scene': 0, 'fallback': 0}

SYSTEM_TAG = 'novel-forge 的写作引擎'
TASKS = {'plan', 'extract', 'review', 'scene'}
KNOWN_NAMES = ['沈砚', '老刀', '顾九', '裴七', '阿棠', '林清', '陈墨', '赵三', '柳娘', '孙九斤']


def norm(t: str) -> str:
    return re.sub(r'[\s“”"\'，,。.！!？?；;：:、—\-…（）()【】\[\]]', '', str(t)).lower()


def pick_quote(quote: str, text: str) -> str:
    """quote 必须能在正文里找到；找不到就退化为正文第一句"""
    if quote and norm(quote) and norm(quote) in norm(text):
        return quote.strip()
    ss = re.split(r'(?<=[。！？])', text)
    for s in ss:
        if len(s.strip()) >= 8:
            return s.strip()[:40]
    return text[:40]


def gen(prompt: str, max_new: int, temp=0.4) -> str:
    msgs = [{'role': 'system', 'content': '你是 novel-forge 写作引擎。只输出要求的“键: 值”行，不要 JSON、不要解释。'},
            {'role': 'user', 'content': prompt}]
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
    ids = tok(text, return_tensors='pt')
    with LOCK, torch.no_grad():
        out = model.generate(**ids, max_new_tokens=max_new, do_sample=temp > 0, temperature=max(0.01, temp),
                             top_p=0.9, repetition_penalty=1.2, pad_token_id=tok.eos_token_id)
    return tok.decode(out[0][ids['input_ids'].shape[1]:], skip_special_tokens=True).strip()


def rows(gen_text: str):
    out = []
    for line in gen_text.splitlines():
        line = line.strip().strip('-•').strip()
        m = re.match(r'^([^:：]{1,12})[:：]\s*(.+)$', line)
        if m:
            out.append((m.group(1).strip(), m.group(2).strip()))
    return out


def get(lines, key, default=''):
    for k, v in lines:
        if k == key:
            return v
    return default


def getall(lines, key):
    return [v for k, v in lines if k == key]


def split(v, n):
    parts = [p.strip() for p in re.split(r'[|｜]', v)]
    while len(parts) < n:
        parts.append('')
    return parts[:n]


def build_plan(lines, material, idx):
    raw_title = re.sub(r'\s+', '', get(lines, '标题') or '')
    title = raw_title[:14] if raw_title and len(raw_title) >= 2 else (re.sub(r'\s+', '', material)[:10] or f'第{idx}章')
    raw_chars = [c.strip() for c in re.split(r'[、,，|]', get(lines, '人物')) if c.strip()]
    # 只认素材里出现过的名字，或项目默认人物；避免模型编人名
    chars = [c for c in raw_chars if c in material or c in KNOWN_NAMES][:6]
    if not chars:
        chars = [n for n in KNOWN_NAMES if n in material][:4]
    beats = []
    for i, v in enumerate(getall(lines, '节拍')[:5]):
        place, present, action, shift = split(v, 4)
        beats.append({'id': f'b{i+1}', 'place': place, 'present': [p.strip() for p in re.split(r'[、,，]', present) if p.strip()],
                      'action': action, 'shift': shift})
    if not beats:
        sents = [x.strip() for x in re.split(r'(?<=[。！？])', material) if len(x.strip()) >= 6][:3] or [material[:30] or '发生一件事']
        beats = [{'id': f'b{i+1}', 'place': '', 'present': chars, 'action': sen[:40], 'shift': '读者多知道一点'} for i, sen in enumerate(sents)]
    hls = []
    for v in getall(lines, '爆点')[:4]:
        kind, typ, inten, htitle, pays = split(v, 5)
        try:
            iv = max(1, min(5, int(float(inten))))
        except Exception:
            iv = 3
        hls.append({'kind': kind or 'beat', 'type': typ or '反转', 'intensity': iv, 'title': htitle or '爆点', 'how': '', 'pays_code': pays})
    if not any(h['kind'] == 'hook' for h in hls):
        hls.append({'kind': 'hook', 'type': '危机', 'intensity': 3, 'title': get(lines, '钩子') or '章末钩子', 'how': '', 'pays_code': ''})
    exps = []
    for v in getall(lines, '期待')[:3]:
        typ, etitle, strength, df, dt = split(v, 5)
        exps.append({'code': f'f{len(exps)+1}', 'type': typ or '悬念', 'title': etitle or '未命名期待',
                     'detail': '', 'strength': int(strength) if strength.isdigit() else 3,
                     'due_from': int(df) if df.isdigit() else idx + 1, 'due_to': int(dt) if dt.isdigit() else idx + 4})
    return {
        'title': title[:20], 'pov': get(lines, '视角') or (chars[0] if chars else ''),
        'characters': chars, 'goal': get(lines, '目标') or (material.strip().split('。')[0][:60] if material.strip() else ''),
        'beats': beats, 'highlights': hls, 'expectations_plant': exps, 'expectations_pay': [],
        'hook': get(lines, '钩子') or '门外的脚步声停了一停。',
        'threads_payoff': [], 'threads_advance': [], 'threads_new': [], 'word_target': 2400,
    }


def build_extract(lines, material, idx):
    facts = []
    for v in getall(lines, '事实')[:6]:
        subj, fact, quote = split(v, 3)
        if not fact:
            continue
        facts.append({'kind': 'fact', 'subject': subj, 'fact': fact, 'quote': pick_quote(quote, material), 'tags': ''})
    tl = []
    for v in getall(lines, '时间线')[:3]:
        t, loc, actors, ev = split(v, 4)
        tl.append({'story_time': t or f'第{idx}天', 'location': loc, 'actors': actors, 'event': ev or material[:20]})
    cus = []
    for v in getall(lines, '人物变化')[:5]:
        name, status, loc, goal, note = split(v, 5)
        if name:
            cus.append({'name': name, 'status': status or 'alive', 'location': loc, 'goal': goal, 'note': note})
    rels = []
    for v in getall(lines, '关系')[:3]:
        f, t, r = split(v, 3)
        if f and t and r:
            rels.append({'from': f, 'to': t, 'relation': r, 'note': ''})
    ths = []
    for v in getall(lines, '线索')[:3]:
        code, action, title, quote, df, dt = split(v, 6)
        if code:
            ths.append({'code': code, 'action': action or 'plant', 'title': title, 'detail': '',
                        'quote': pick_quote(quote, material),
                        'due_from': int(df) if df.isdigit() else idx + 2, 'due_to': int(dt) if dt.isdigit() else idx + 6})
    exps = []
    for v in getall(lines, '期待事件')[:3]:
        code, action, title, quote = split(v, 4)
        if code:
            exps.append({'code': code, 'action': action or 'plant', 'type': '立旗', 'title': title, 'detail': '',
                         'strength': 3, 'quote': pick_quote(quote, material)})
    hls = []
    for v in getall(lines, '爆点')[:4]:
        kind, typ, inten, htitle, quote, pays = split(v, 6)
        try:
            iv = max(1, min(5, int(float(inten))))
        except Exception:
            iv = 3
        hls.append({'kind': kind or 'beat', 'type': typ or '反转', 'intensity': iv, 'title': htitle or '爆点',
                    'quote': pick_quote(quote, material), 'pays_code': pays})
    if not any(h['kind'] == 'hook' for h in hls):
        hls.append({'kind': 'hook', 'type': '危机', 'intensity': 3, 'title': '章末钩子', 'quote': pick_quote('', material)})
    if not facts:
        sents = [x.strip() for x in re.split(r'(?<=[。！？])', material) if len(x.strip()) >= 6][:3]
        for sen in sents:
            who = next((n for n in ['沈砚', '老刀', '顾九', '裴七', '阿棠', '林清', '陈墨'] if n in sen), '')
            facts.append({'kind': 'fact', 'subject': who, 'fact': sen[:30], 'quote': sen[:30], 'tags': ''})
    if not tl and material:
        tl.append({'story_time': f'第{idx}天', 'location': '', 'actors': '', 'event': material.strip()[:30]})
    return {
        'summary': get(lines, '摘要') or (material.strip().replace('\n', '')[:80] + '……'),
        'facts': facts, 'timeline': tl, 'character_updates': cus, 'relation_updates': rels,
        'thread_events': ths, 'expectation_events': exps, 'highlights': hls,
    }


def build_review(lines, material):
    verdict = get(lines, '结论') or 'revise'
    nums = [x for x in re.split(r'[、,，\s]+', get(lines, '分数')) if x.replace('.', '').isdigit()][:6]
    while len(nums) < 6:
        nums.append('7')
    keys = ['continuity', 'voice', 'pacing', 'information', 'anti_slop', 'characters']
    issues = []
    for v in getall(lines, '问题')[:6]:
        sev, typ, msg, quote, fix = split(v, 5)
        issues.append({'severity': sev or 'warn', 'type': typ or 'voice', 'quote': pick_quote(quote, material) if quote else '',
                       'why': msg, 'fix': fix})
    return {'verdict': 'pass' if verdict.startswith('pass') else 'revise',
            'scores': {k: int(float(n)) for k, n in zip(keys, nums)}, 'issues': issues}


def task_of(user: str):
    m = re.search(r'任务[:：]\s*(plan|extract|review|scene)', user)
    if m:
        return m.group(1)
    u = user
    # 按项目真实提示词的结构标记判定，顺序很关键
    if ('【本场景】' in u) or ('个场景' in u and '【本章目标】' in u):
        return 'scene'
    if ('抽取' in u) or ('thread_events' in u) or ('结构化事实' in u):
        return 'extract'
    if ('审稿' in u) or ('anti_slop' in u) or ('verdict' in u):
        return 'review'
    if ('策划' in u) or ('节拍' in u) or ('"beats"' in u):
        return 'plan'
    if '场景' in u or '正文' in u:
        return 'scene'
    return ''


def chapter_idx(user: str, default=1):
    m = re.search(r'第\s*(\d+)\s*章', user)
    return int(m.group(1)) if m else default


def material_of(user: str) -> str:
    for marker in ['【上一章结尾原文】', '【上一段正文的结尾（直接接上，不要重复它的内容）】', '【本章】', '素材：', '正文：']:
        i = user.find(marker)
        if i >= 0:
            return user[i + len(marker):][:1200].strip()
    return user[:1200]


def strict_answer(task, user):
    material = material_of(user)
    idx = chapter_idx(user)
    if task == 'plan':
        prompt = f"""只输出下面这些行，不要 JSON、不要解释。缺信息就合理补一句。
标题: <本章标题，12字内>
视角: <主视角人物>
人物: <出场人物，逗号分隔>
目标: <本章要发生的一件事>
节拍: <地点|在场人物|动作|信息变化>（输出 2-4 行“节拍:”）
爆点: <beat|反转|强度1-5|爆点标题|关联期待code或空>（1-2 行）
爆点: <hook|危机|强度3|章末钩子标题|空>
期待: <立旗|读者在等什么|强度3|起章|最晚章>（0-2 行）
钩子: <章末钩子一句话>

素材：
{material}"""
        raw = gen(prompt, 220, 0.5)
        data = build_plan(rows(raw), material, idx)
    elif task == 'extract':
        prompt = f"""只输出下面这些行，不要 JSON、不要解释。引用必须逐字来自正文。
摘要: <3 句内发生了什么>
事实: <主体|一句话事实|正文原句片段>（1-3 行）
时间线: <故事内时间|地点|人物|事件>（1 行）
人物变化: <姓名|alive/dead|地点|目标|备注>（0-2 行）
关系: <从谁|到谁|一句话关系>（0-2 行）
线索: <code|plant/advance/payoff|标题|正文原句|起章|止章>（0-1 行）
期待事件: <code|plant/fulfill|标题|正文原句>（0-1 行）
爆点: <beat|反转|强度1-5|标题|正文原句|pays_code>（1 行）
爆点: <hook|危机|强度3|标题|正文原句|空>

正文：
{material}"""
        raw = gen(prompt, 320, 0.4)
        data = build_extract(rows(raw), material, idx)
    else:
        prompt = f"""只输出下面这些行，不要 JSON。
结论: <pass 或 revise>
分数: <continuity,voice,pacing,information,anti_slop,characters 六个 1-10 的数字，逗号分隔>
问题: <severity|type|说明|正文原句|怎么改>（0-4 行）

正文：
{material}"""
        raw = gen(prompt, 200, 0.3)
        data = build_review(rows(raw), material)
    return data


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        if self.path.startswith('/v1/forge/stats'):
            return self._send(200, STATS)
        if self.path.startswith('/v1/models'):
            return self._send(200, {'object': 'list', 'data': [{'id': 'novel-forge-v1', 'object': 'model'}]})
        return self._send(200, {'status': 'ok'})

    def do_POST(self):
        if not self.path.startswith('/v1/chat/completions'):
            return self._send(404, {'error': 'not found'})
        n = int(self.headers.get('content-length', 0))
        req = json.loads(self.rfile.read(n) or b'{}')
        msgs = req.get('messages', [])
        user = next((m['content'] for m in reversed(msgs) if m.get('role') == 'user'), '')
        task = task_of(user)
        t0 = time.time()
        if task in ('plan', 'extract', 'review'):
            data = strict_answer(task, user)
            STATS[task] += 1
            content = json.dumps(data, ensure_ascii=False)
            pt = len(user) // 2
            ct = len(content) // 2
        elif task == 'scene':
            material = re.sub(r'^任务[:：].*\n', '', user)[:1000]
            content = gen(f'续写下面这段小说，保持同一文风，约 500 字，只输出正文：\n{material}', int(req.get('max_tokens', 600) or 600), 0.85)
            STATS['scene'] += 1
            pt, ct = len(material) // 2, len(content) // 2
        else:
            STATS['fallback'] += 1
            content = json.dumps({'error': 'NOVELFORGE_ONLY'}, ensure_ascii=False)
            pt = ct = 0
        self._send(200, {
            'id': 'chatcmpl-forge', 'object': 'chat.completion', 'model': 'novel-forge-v1',
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': pt, 'completion_tokens': ct, 'total_tokens': pt + ct},
            'elapsed': round(time.time() - t0, 2),
        })

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    print(f'forge-strict serving {a.model} on http://{a.host}:{a.port}/v1')
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()
