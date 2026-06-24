# XiaoBa Eval Fake Repo

Minimal smoke fixture for `xiaoba eval`.

Suggested command from the XiaoBa checkout after `npm run build`:

```powershell
node dist\index.js eval `
  --cwd tests\fixtures\eval-fake-repo `
  --prompt-file tests\fixtures\eval-fake-repo\task.md `
  --session-key eval-fake-add `
  --run-root .dev-user-data\eval-runs\fake-add `
  --output-json .dev-user-data\eval-runs\fake-add\result.json `
  --max-minutes 10 `
  --auto-approve-tools read_file,glob,grep,write_file,edit_file,execute_shell `
  --model-source env `
  --no-interactive `
  --no-dashboard
```

Use `--env-file <path>` when model credentials are not already present in the shell environment.
