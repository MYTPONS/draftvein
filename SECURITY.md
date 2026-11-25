# Security

Do not commit API keys, writer-assistant cookies, QR login artifacts, local databases, or personal runtime configuration.

The public repository intentionally excludes:

- `.dsh/` session and project records
- `data/`, `shots/`, exports, and model files
- `config.json`, `.env`, and local runtime data
- local gateway scripts and machine-specific paths

Use `.env.example` or `config.example.json` as templates. Report suspected secret exposure privately to the repository owner rather than opening a public issue containing the secret.
