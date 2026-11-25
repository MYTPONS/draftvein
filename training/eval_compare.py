#!/usr/bin/env python3
"""同一组提示，跑 base 与微调模型，输出样本 + 套话计数，便于前后对比。
用法：python eval_compare.py --model <path> --tag base
"""
import argparse, json, os, re, torch
from transformers import AutoModelForCausalLM, AutoTokenizer

BANNED = ['仿佛', '似乎', '不由得', '不禁', '缓缓', '目光如炬', '一丝', '一抹', '嘴角上扬', '心中一凛', '空气中弥漫', '与此同时', '这一刻']

PROMPTS = [
    ("写一段中文悬疑小说正文，约 350 字。人物：沈砚（当铺接手人，话少、算得清）、老刀（茶楼掌柜，笑面，爱打岔）。场景：茶楼二层，老刀用暗语试探沈砚。要求：短句为主；情绪用动作写；禁止套话；最后留一个具体的不安。只输出正文。", "悬疑·茶楼试探"),
    ("写一段中文都市小说正文，约 350 字。人物：沈砚、林清。场景：旧城当铺打烊后，林清带来一张写着名字的纸条。要求：对白为主，短句，不要总结，结尾留钩子。只输出正文。", "都市·当铺纸条"),
    ("续写下面这段小说，保持文风，约 300 字：\n沈砚把名单折成四折，塞进内袋。老刀在柜台后头抬了抬眼皮，没问。", "续写·名单"),
]


def slop(t):
    return {b: t.count(b) for b in BANNED if b in t}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--out", default=os.path.expanduser("~/data/novels/sft"))
    ap.add_argument("--max-new", type=int, default=420)
    a = ap.parse_args()
    torch.set_num_threads(20)
    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=torch.float32, trust_remote_code=True, attn_implementation="sdpa")
    model.eval()
    rows = []
    for prompt, name in PROMPTS:
        msgs = [{"role": "system", "content": "你是中文网文作者，直接输出正文。"}, {"role": "user", "content": prompt}]
        text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        ids = tok(text, return_tensors="pt")
        with torch.no_grad():
            out = model.generate(
                **ids, max_new_tokens=a.max_new, do_sample=True, temperature=0.85, top_p=0.9,
                repetition_penalty=1.25, pad_token_id=tok.eos_token_id,
            )
        gen = tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)
        rows.append({"name": name, "prompt": prompt, "text": gen, "chars": len(gen), "slop": slop(gen)})
        print(f"=== {a.tag} | {name} | {len(gen)} 字 | 套话 {sum(rows[-1]['slop'].values())} {rows[-1]['slop']}")
    path = os.path.join(a.out, f"eval_{a.tag}.json")
    json.dump(rows, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print("saved", path)


if __name__ == "__main__":
    main()
