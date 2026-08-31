#!/usr/bin/env bash

set -uo pipefail

declare -A scopes=(
  [all]=false
  [quality]=false
  [unit]=false
  [e2e]=false
  [build]=false
  [duplication]=false
  [osv]=false
  [semgrep]=false
  [codeql_actions]=false
  [codeql_javascript]=false
  [pinned_tools]=false
  [deep_fast]=false
  [codex_security]=false
)

readonly scope_order=(
  all
  quality
  unit
  e2e
  build
  duplication
  osv
  semgrep
  codeql_actions
  codeql_javascript
  pinned_tools
  deep_fast
  codex_security
)

mark() {
  local scope
  for scope in "$@"; do
    scopes["$scope"]=true
  done
}

mark_all() {
  local scope
  for scope in "${scope_order[@]}"; do
    scopes["$scope"]=true
  done
}

is_fast_mutation_source() {
  local path="$1"

  case "$path" in
    src/*.d.ts | src/types/** | src/main.ts | src/renderer/** | src/chat/**)
      return 1
      ;;
    src/app/chat-availability-preflight.ts | \
      src/app/overlay.ts | \
      src/app/runtime-manager.ts | \
      src/app/standby-controller.ts | \
      src/app/video-pause-controller.ts | \
      src/media/image-fetch-manager.ts | \
      src/platform/menu-adapters.ts | \
      src/platform/storage-adapters.ts | \
      src/platform/worker-factory.ts | \
      src/settings/store.ts | \
      src/settings/ui/controller.ts | \
      src/settings/ui/form.ts | \
      src/settings/ui/panes.ts | \
      src/settings/ui/styles.ts | \
      src/translation/service.ts | \
      src/translation/language-detector.ts | \
      src/util/backlog-indicator.ts | \
      src/util/backlog-sampler.ts | \
      src/util/observability.ts)
      return 1
      ;;
    src/**/*.ts | src/*.ts)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

classify_path() {
  local path="$1"

  case "$path" in
    scripts/ci/classify-workflow-changes.sh)
      mark_all
      ;;
    packages/core | .gitmodules | package.json | pnpm-lock.yaml | pnpm-workspace.yaml)
      mark quality unit e2e build osv semgrep codeql_javascript pinned_tools deep_fast codex_security
      ;;
    src/**)
      mark quality unit e2e build duplication semgrep codeql_javascript codex_security
      if is_fast_mutation_source "$path"; then
        mark deep_fast
      fi
      ;;
    extension/icons/**)
      mark e2e build
      ;;
    extension/**/*.ts | extension/*.ts)
      mark quality unit e2e build semgrep codeql_javascript codex_security
      ;;
    extension/*.json)
      mark quality unit e2e build semgrep codex_security
      ;;
    tooling/** | vite.config.ts | vite.config.*.ts)
      mark quality unit e2e build semgrep codeql_javascript codex_security
      ;;
    test/e2e/**)
      mark quality e2e semgrep codeql_javascript codex_security
      ;;
    test/unit/** | test/consistency/** | test/setup.ts)
      mark quality unit semgrep codeql_javascript deep_fast codex_security
      ;;
    test/visual/**)
      mark semgrep codeql_javascript codex_security
      ;;
    nose.toml | .nose-baseline.json)
      mark quality duplication semgrep codex_security
      ;;
    biome.json | knip.json | tsconfig*.json | vitest.config.ts | stryker.conf*.json)
      mark quality unit e2e build semgrep codeql_javascript deep_fast codex_security
      ;;
    scripts/security/codex-security/**)
      mark unit osv semgrep pinned_tools codex_security
      ;;
    scripts/**)
      mark quality unit build semgrep codeql_javascript codex_security
      case "$path" in
        scripts/ci/**)
          mark pinned_tools
          ;;
      esac
      ;;
    .github/workflows/ci.yaml)
      mark quality unit e2e build duplication semgrep codeql_actions pinned_tools codex_security
      ;;
    .github/workflows/security.yaml)
      mark quality unit osv semgrep codeql_actions pinned_tools codex_security
      ;;
    .github/workflows/deep-checks.yaml)
      mark quality unit semgrep codeql_actions pinned_tools deep_fast codex_security
      ;;
    .github/workflows/release.yaml)
      mark quality unit e2e build duplication semgrep codeql_actions pinned_tools codex_security
      ;;
    .github/workflows/**)
      mark quality unit semgrep codeql_actions pinned_tools codex_security
      ;;
    .github/actions/**)
      mark quality unit build semgrep codeql_actions pinned_tools codex_security
      ;;
    .github/settings.yaml)
      mark quality unit semgrep codeql_actions codex_security
      ;;
    .github/codex-security/**)
      mark unit osv semgrep pinned_tools codex_security
      ;;
    .github/SECURITY.md | PRIVACY.md)
      mark semgrep codex_security
      ;;
    .githooks/**)
      mark semgrep codex_security
      ;;
    README.md | CHANGELOG.md | CODE_OF_CONDUCT.md | CONTRIBUTING.md | LICENSE | SUPPORT.md | \
      extension/README.md | docs/** | .github/ISSUE_TEMPLATE/** | .github/pull_request_template.md | \
      .github/CODEOWNERS | .github/dependabot.yaml | .gitignore | .gitattributes | test/.gitignore)
      mark semgrep
      ;;
    *)
      echo "Unknown workflow path; enabling every scope: $path" >&2
      mark_all
      ;;
  esac
}

emit_outputs() {
  local scope line
  for scope in "${scope_order[@]}"; do
    line="$scope=${scopes[$scope]}"
    printf '%s\n' "$line"
    if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
      printf '%s\n' "$line" >> "$GITHUB_OUTPUT"
    fi
  done
}

classify_paths() {
  local path
  for path in "$@"; do
    classify_path "$path"
  done
}

resolve_changed_paths() {
  local event_name="${EVENT_NAME:-}"
  local base_sha="${BASE_SHA:-}"
  local head_sha="${HEAD_SHA:-}"
  local range
  local temp_file
  local -a changed_paths=()

  case "$event_name" in
    workflow_dispatch | schedule)
      echo "$event_name requests complete verification." >&2
      mark_all
      return
      ;;
    pull_request | merge_group)
      range="$base_sha...$head_sha"
      ;;
    push)
      if [[ "$base_sha" =~ ^0{40}$ ]]; then
        echo "Push has no usable base revision; enabling every scope." >&2
        mark_all
        return
      fi
      range="$base_sha..$head_sha"
      ;;
    *)
      echo "Unknown workflow event; enabling every scope: ${event_name:-<empty>}" >&2
      mark_all
      return
      ;;
  esac

  if [[ ! "$base_sha" =~ ^[0-9a-f]{40}$ || ! "$head_sha" =~ ^[0-9a-f]{40}$ ]] || \
    ! git cat-file -e "$base_sha^{commit}" 2>/dev/null || \
    ! git cat-file -e "$head_sha^{commit}" 2>/dev/null; then
    echo "Workflow revisions are unavailable; enabling every scope." >&2
    mark_all
    return
  fi

  temp_file="$(mktemp)" || {
    echo "Unable to allocate a diff file; enabling every scope." >&2
    mark_all
    return
  }

  if ! git diff --name-only --diff-filter=ACMRD -z "$range" > "$temp_file"; then
    echo "Unable to calculate workflow diff; enabling every scope." >&2
    rm -f -- "$temp_file"
    mark_all
    return
  fi

  mapfile -d '' -t changed_paths < "$temp_file"
  rm -f -- "$temp_file"
  if (( ${#changed_paths[@]} == 0 )); then
    echo "Workflow diff is empty; enabling every scope." >&2
    mark_all
    return
  fi
  classify_paths "${changed_paths[@]}"
}

if [[ "${1:-}" == "--paths" ]]; then
  shift
  classify_paths "$@"
else
  resolve_changed_paths
fi

emit_outputs
