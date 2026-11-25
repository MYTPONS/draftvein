#!/usr/bin/env python3
"""在 draftvein 专属数据上继续训练（可从上一次 adapter 续训 = "慢慢训练"）。
用法：
  python train_forge.py --init ~/models/qwen0.5b/lora_adapter --out ~/models/forge-lora --steps 200
"""
import argparse, json, os, torch
from torch.utils.data import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, Trainer, TrainingArguments, DataCollatorForSeq2Seq
from peft import LoraConfig, PeftModel, get_peft_model

torch.set_num_threads(max(8, (os.cpu_count() or 8) - 2))


class ForgeSFT(Dataset):
    def __init__(self, path, tok, max_len=448, max_out=420):
        self.rows = [json.loads(l) for l in open(path, encoding='utf-8')]
        self.tok, self.max_len, self.max_out = tok, max_len, max_out

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        r = self.rows[i]
        msgs = [{'role': 'system', 'content': r['system']}, {'role': 'user', 'content': r['user']}]
        prompt = self.tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        target = r['assistant'][: self.max_out] + self.tok.eos_token
        enc = self.tok(prompt + target, truncation=True, max_length=self.max_len, padding=False)
        plen = len(self.tok(prompt, truncation=True, max_length=self.max_len)['input_ids'])
        labels = list(enc['input_ids'])
        for k in range(min(plen, len(labels))):
            labels[k] = -100
        enc['labels'] = labels
        return enc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--model', default=os.path.expanduser('~/models/qwen0.5b'))
    ap.add_argument('--data', default=os.path.expanduser('~/data/novels/sft'))
    ap.add_argument('--init', default='', help='从上一次的 lora_adapter 续训')
    ap.add_argument('--out', default=os.path.expanduser('~/models/forge-lora'))
    ap.add_argument('--steps', type=int, default=200)
    ap.add_argument('--accum', type=int, default=4)
    ap.add_argument('--lr', type=float, default=1.5e-4)
    ap.add_argument('--maxlen', type=int, default=448)
    ap.add_argument('--dtype', default='float32', choices=['float32', 'bfloat16'])
    ap.add_argument('--grad-ckpt', action='store_true')
    a = ap.parse_args()

    tok = AutoTokenizer.from_pretrained(a.model, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    mdt = torch.bfloat16 if a.dtype == 'bfloat16' else torch.float32
    model = AutoModelForCausalLM.from_pretrained(a.model, dtype=mdt, trust_remote_code=True, attn_implementation='sdpa')
    model.config.use_cache = False
    if a.grad_ckpt:
        model.gradient_checkpointing_enable()
        model.enable_input_require_grads()
    if a.init and os.path.isdir(a.init):
        model = PeftModel.from_pretrained(model, a.init, is_trainable=True)
        print('resumed from', a.init)
    else:
        model = get_peft_model(model, LoraConfig(
            r=16, lora_alpha=32, lora_dropout=0.05, bias='none', task_type='CAUSAL_LM',
            target_modules=['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
        ))
    model.print_trainable_parameters()

    train = ForgeSFT(os.path.join(a.data, 'forge_train.jsonl'), tok, a.maxlen)
    evals = ForgeSFT(os.path.join(a.data, 'forge_eval.jsonl'), tok, a.maxlen, 2000)
    collator = DataCollatorForSeq2Seq(tok, model=model, padding=True, label_pad_token_id=-100)
    targs = TrainingArguments(
        output_dir=os.path.join(a.out, 'ckpt'),
        max_steps=a.steps,
        per_device_train_batch_size=1,
        gradient_accumulation_steps=a.accum,
        learning_rate=a.lr,
        lr_scheduler_type='cosine',
        warmup_steps=15,
        logging_steps=5,
        save_strategy='no',
        eval_strategy='no',
        report_to=[],
        remove_unused_columns=False,
        dataloader_num_workers=0,
        use_cpu=True,
        bf16=(a.dtype == 'bfloat16'),
    )
    Trainer(model=model, args=targs, train_dataset=train, eval_dataset=evals, data_collator=collator).train()
    os.makedirs(a.out, exist_ok=True)
    model.save_pretrained(os.path.join(a.out, 'lora_adapter'))
    merged = model.merge_and_unload()
    merged.save_pretrained(os.path.join(a.out, 'merged'), safe_serialization=True)
    tok.save_pretrained(os.path.join(a.out, 'merged'))
    print('saved', a.out)


if __name__ == '__main__':
    main()
