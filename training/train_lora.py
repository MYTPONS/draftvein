#!/usr/bin/env python3
"""LoRA 微调：只要"写小说"能力，其它任务一律不喂。
用法：
  python train_lora.py --model ~/models/qwen0.5b --out ~/models/qwen0.5b-novel --steps 400
"""
import argparse, json, os, torch
from torch.utils.data import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments, DataCollatorForSeq2Seq
from peft import LoraConfig, get_peft_model

SYSTEM = "你是中文网文作者。只写小说正文：短句为主，情绪用动作写，不解释设定，不总结。"


class SFT(Dataset):
    def __init__(self, path, tok, max_len=512):
        self.rows = [json.loads(l) for l in open(path, encoding="utf-8")]
        self.tok = tok
        self.max_len = max_len

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        msgs = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": f"{r['instruction']}\n\n{r['input']}"},
            {"role": "assistant", "content": r["output"]},
        ]
        prompt = self.tok.apply_chat_template(msgs[:2], tokenize=False, add_generation_prompt=True)
        full = prompt + r["output"] + self.tok.eos_token
        enc = self.tok(full, truncation=True, max_length=self.max_len, padding=False)
        plen = len(self.tok(prompt, truncation=True, max_length=self.max_len)["input_ids"])
        labels = list(enc["input_ids"])
        for k in range(min(plen, len(labels))):
            labels[k] = -100
        enc["labels"] = labels
        return enc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=os.path.expanduser("~/models/qwen0.5b"))
    ap.add_argument("--data", default=os.path.expanduser("~/data/novels/sft"))
    ap.add_argument("--out", default=os.path.expanduser("~/models/qwen0.5b-novel"))
    ap.add_argument("--steps", type=int, default=400)
    ap.add_argument("--bs", type=int, default=1)
    ap.add_argument("--accum", type=int, default=4)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--maxlen", type=int, default=512)
    args = ap.parse_args()

    tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(args.model, torch_dtype=torch.float32, trust_remote_code=True)
    model.config.use_cache = False
    lora = LoraConfig(
        r=16, lora_alpha=32, lora_dropout=0.05, bias="none", task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    train = SFT(os.path.join(args.data, "train.jsonl"), tok, args.maxlen)
    evals = SFT(os.path.join(args.data, "eval.jsonl"), tok, args.maxlen)
    collator = DataCollatorForSeq2Seq(tok, model=model, padding=True, label_pad_token_id=-100)

    targs = TrainingArguments(
        output_dir=os.path.join(args.out, "ckpt"),
        max_steps=args.steps,
        per_device_train_batch_size=args.bs,
        gradient_accumulation_steps=args.accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_steps=20,
        logging_steps=10,
        save_strategy="no",
        eval_strategy="no",
        report_to=[],
        remove_unused_columns=False,
        dataloader_num_workers=0,
        use_cpu=True,
    )
    trainer = Trainer(model=model, args=targs, train_dataset=train, eval_dataset=evals, data_collator=collator)
    trainer.train()
    model.save_pretrained(os.path.join(args.out, "lora_adapter"))
    merged = model.merge_and_unload()
    merged.save_pretrained(args.out, safe_serialization=True)
    tok.save_pretrained(args.out)
    print("saved", args.out)


if __name__ == "__main__":
    main()
