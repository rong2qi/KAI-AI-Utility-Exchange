#!/usr/bin/env bash
set -euo pipefail

repo="${GITHUB_REPOSITORY:-rong2qi/KAI-AI-Utility-Exchange}"
environment="${GITHUB_ENVIRONMENT:-staging}"
secret_name="${DAHONO_SECRET_NAME:-DAHONO_API_KEY}"

if ! command -v gh >/dev/null 2>&1; then
  echo "缺少 GitHub CLI（gh），无法写入受保护环境密钥。" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI 尚未登录，请先完成 gh 登录。" >&2
  exit 1
fi

printf '请输入 Dahono 测试密钥（输入不会显示）： '
IFS= read -r -s secret
printf '\n'

if [[ -z "$secret" ]]; then
  echo "密钥不能为空，未执行写入。" >&2
  exit 1
fi

# 仅通过 stdin 交给 gh，避免命令行参数、shell history 和日志暴露密钥。
if ! printf '%s' "$secret" | gh secret set "$secret_name" --env "$environment" --repo "$repo"; then
  unset secret
  echo "GitHub 环境密钥写入失败，未声称已就位。" >&2
  exit 1
fi
unset secret

# 只核对名称和更新时间，不读取或回显密钥值。
if record=$(gh secret list --env "$environment" --repo "$repo" --json name,updatedAt \
  --jq ".[] | select(.name == \"$secret_name\") | \"secret_name=\(.name) updated_at=\(.updatedAt)\"") \
  && [[ -n "$record" ]]; then
  printf '%s\n' "$record"
  echo "密钥已写入受保护环境：${environment}/${secret_name}（值未读取）。"
else
  echo "无法核对受保护环境密钥，未声称已就位。" >&2
  exit 1
fi
