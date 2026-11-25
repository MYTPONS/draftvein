#!/usr/bin/env python3
"""把中文小说 txt 切成"续写"指令样本，输出 train.jsonl / eval.jsonl"""
import glob, json, os, random, re

random.seed(42)
INSTR = [
    "续写下面这段小说正文，保持同一人称与文风，约 400 字。只输出正文。",
    "接着写下去：保持人物口吻和叙事节奏，约 400 字。只输出正文。",
    "按上面的文风续写 400 字，不要总结、不要解释。",
]

def clean(t: str) -> str:
    t = t.replace("\r", "\n").replace("\u3000", " ")
    t = re.sub(r"\n{3,}", "\n\n", t)
    t = re.sub(r"[ \t]{2,}", " ", t)
    return t.strip()

def chunks(text: str, size=650, step=450):
    for i in range(0, len(text) - size, step):
        yield text[i : i + size]

def main():
    files = sorted(glob.glob(os.path.expanduser("~/data/novels/n*.txt")))
    samples = []
    for f in files:
        raw = open(f, encoding="utf-8", errors="ignore").read()
        raw = clean(raw)
        for ch in chunks(raw):
            # 去掉目录式、纯对话清单式的垃圾段落
            if ch.count("\n") > 40 or len(set(ch)) < 120:
                continue
            cut = ch.rfind("。", 200, 420)
            if cut < 0:
                continue
            prompt, resp = ch[: cut + 1], ch[cut + 1 :].strip()
            if len(resp) < 180:
                continue
            samples.append({"instruction": random.choice(INSTR), "input": prompt, "output": resp[:500]})
    random.shuffle(samples)
    n_eval = max(50, len(samples) // 50)
    os.makedirs(os.path.expanduser("~/data/novels/sft"), exist_ok=True)
    out = os.path.expanduser("~/data/novels/sft")
    with open(f"{out}/eval.jsonl", "w", encoding="utf-8") as fh:
        for s in samples[:n_eval]:
            fh.write(json.dumps(s, ensure_ascii=False) + "\n")
    with open(f"{out}/train.jsonl", "w", encoding="utf-8") as fh:
        for s in samples[n_eval:]:
            fh.write(json.dumps(s, ensure_ascii=False) + "\n")
    print(f"train={len(samples)-n_eval} eval={n_eval} dir={out}")

if __name__ == "__main__":
    main()
