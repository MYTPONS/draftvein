#!/usr/bin/env python3
"""把微调后的 HF 模型暴露成 OpenAI 兼容接口（CPU）。
用法：python serve_hf.py --model ~/models/qwen0.5b-novel --port 8095
"""
import argparse, json, os, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

ap = argparse.ArgumentParser()
ap.add_argument("--model", default=os.path.expanduser("~/models/qwen0.5b-novel"))
ap.add_argument("--port", type=int, default=8095)
ap.add_argument("--host", default="127.0.0.1")
ap.add_argument("--threads", type=int, default=20)
args = ap.parse_args()

torch.set_num_threads(args.threads)
tok = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
model = AutoModelForCausalLM.from_pretrained(args.model, torch_dtype=torch.float32, trust_remote_code=True)
model.eval()
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", ""):
            return self._json(200, {"status": "ok"})
        if self.path.startswith("/v1/models"):
            return self._json(200, {"object": "list", "data": [{"id": "novel-lora", "object": "model"}]})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/v1/chat/completions"):
            return self._json(404, {"error": "not found"})
        n = int(self.headers.get("content-length", 0))
        req = json.loads(self.rfile.read(n) or b"{}")
        msgs = req.get("messages", [])
        prompt = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True)
        inputs = tok(prompt, return_tensors="pt")
        gen_kwargs = dict(
            max_new_tokens=int(req.get("max_tokens", 512)),
            do_sample=float(req.get("temperature", 0.8)) > 0,
            temperature=max(0.01, float(req.get("temperature", 0.8))),
            top_p=float(req.get("top_p", 0.9)),
            repetition_penalty=1.0 + float(req.get("frequency_penalty", 0.0)) * 0.5,
            pad_token_id=tok.eos_token_id,
        )
        t0 = time.time()
        with lock, torch.no_grad():
            out = model.generate(**inputs, **gen_kwargs)
        text = tok.decode(out[0][inputs["input_ids"].shape[1] :], skip_special_tokens=True)
        pt = inputs["input_ids"].shape[1]
        ct = out.shape[1] - pt
        self._json(
            200,
            {
                "id": "chatcmpl-local",
                "object": "chat.completion",
                "model": "novel-lora",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": pt, "completion_tokens": ct, "total_tokens": pt + ct},
                "elapsed": round(time.time() - t0, 2),
            },
        )

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"serving {args.model} on http://{args.host}:{args.port}/v1")
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
