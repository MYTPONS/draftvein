#!/usr/bin/env python3
"""评测：本项目 JSON 契约的遵循率（plan/extract/review）+ 非小说请求是否被拒。
用法：python eval_contract.py --model <path> --tag base
"""
import argparse, json, os, re, torch
from transformers import AutoModelForCausalLM, AutoTokenizer

REQ = {
    'plan': ['title', 'goal', 'beats', 'highlights', 'hook'],
    'extract': ['summary', 'facts', 'timeline', 'thread_events', 'highlights'],
    'review': ['verdict', 'scores', 'issues'],
}


def task_of(user):
    m = re.search(r'任务：(\w+)', user)
    return m.group(1) if m else 'none'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', required=True)
    ap.add_argument('--tag', required=True)
    ap.add_argument('--dir', default=os.path.expanduser('~/data/novels/sft'))
    ap.add_argument('--n', type=int, default=40)
    ap.add_argument('--max-new', type=int, default=320)
    a = ap.parse_args()
    torch.set_num_threads(20)
    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32, trust_remote_code=True, attn_implementation='sdpa')
    model.eval()

    rows = [json.loads(l) for l in open(os.path.join(a.dir, 'forge_eval.jsonl'), encoding='utf-8')][: a.n]
    stats = {'parse': 0, 'schema': 0, 'refusal': 0, 'refused_correct': 0, 'total': 0}
    by_kind = {}
    samples = []
    for r in rows:
        msgs = [{'role': 'system', 'content': r['system']}, {'role': 'user', 'content': r['user']}]
        text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        ids = tok(text, return_tensors='pt')
        with torch.no_grad():
            out = model.generate(**ids, max_new_tokens=a.max_new, do_sample=False, pad_token_id=tok.eos_token_id)
        gen = tok.decode(out[0][ids['input_ids'].shape[1]:], skip_special_tokens=True)
        kind = task_of(r['user'])
        stats['total'] += 1
        ok_parse, ok_schema = False, False
        data = None
        m = re.search(r'\{[\s\S]*\}', gen)
        if m:
            try:
                data = json.loads(m.group(0))
                ok_parse = True
            except Exception:
                ok_parse = False
        if kind == 'none':
            stats['refusal'] += 1
            if ok_parse and isinstance(data, dict) and data.get('error') == 'NOVELFORGE_ONLY':
                stats['refused_correct'] += 1
        elif ok_parse and isinstance(data, dict):
            ok_schema = all(k in data for k in REQ.get(kind, []))
        stats['parse'] += int(ok_parse)
        stats['schema'] += int(ok_schema)
        bk = by_kind.setdefault(kind, {'n': 0, 'schema': 0})
        bk['n'] += 1
        bk['schema'] += int(ok_schema)
        if len(samples) < 3:
            samples.append({'kind': kind, 'gen': gen[:400]})
    res = {
        'tag': a.tag,
        'json_parse_rate': round(stats['parse'] / max(1, stats['total']), 3),
        'schema_rate': round(stats['schema'] / max(1, stats['total']), 3),
        'by_kind': {k: round(v['schema'] / max(1, v['n']), 3) for k, v in by_kind.items()},
        'samples': samples,
    }
    print(json.dumps(res, ensure_ascii=False, indent=2))
    json.dump(res, open(os.path.join(a.dir, f'contract_{a.tag}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
