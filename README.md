# claude-token-monitor

Plugin do Claude Code que mostra seu uso de tokens **lendo direto os arquivos locais** (`~/.claude/projects/**/*.jsonl`). Sem API key, sem internet, sem dependência da Anthropic.

## Instalação

```bash
claude /plugin install https://github.com/wgallego0/claude-token-monitor
```

Ou via marketplace local — adicione o diretório como repo em `~/.claude/plugins`.

## Uso

Dentro do Claude Code, digite:

```
/usage
```

Saída:

```
Claude Code · Token Usage
────────────────────────────────────────────────────────

Hoje   (2026-05-17)    1.2M   $14.30   42 msgs
Mês    (2026-05)      18.4M  $218.50  612 msgs
Total                 87.3M  $1037.20 2843 msgs

Últimos 14 dias
────────────────────────────────────────────────────────
2026-05-04  ████░░░░░░░░░░░░░░░░░░░░    250k
2026-05-05  ████████░░░░░░░░░░░░░░░░    500k
...

Top projetos
────────────────────────────────────────────────────────
  yellowBoard                    8.5M    $101.20
  truelicense                    6.2M     $73.40
  ...
```

## Como funciona

- Cada turno do Claude Code é gravado em `~/.claude/projects/<id>/<session>.jsonl`
- Cada linha JSONL com `message.usage` contém `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`
- O script soma tudo, agrupa por data (do `timestamp` da linha) e por projeto
- Preços são Sonnet 4.5 ($3 in / $15 out / $0.30 cache R / $3.75 cache W por 1M tokens) — edite `scripts/usage.js` se for outro modelo

## Flags

```bash
node scripts/usage.js          # relatório human-readable (padrão)
node scripts/usage.js --json   # JSON pra consumir em script
node scripts/usage.js --today  # uma linha: "1.2M tok hoje · $14.30"
```

O `--today` é útil pra integrar com statusline (ver settings.json do Claude Code).

## Alternativas

- [`ccusage`](https://www.npmjs.com/package/ccusage) — pacote npm popular do `ryoppippi`, mesma ideia mas mais features (filtro por modelo, export CSV, etc.). Roda via `npx ccusage`.
