## Context Usage

**Model:** claude-opus-5-5  
**Tokens:** 16.7k / 1m (2%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.6k | 0.3% |
| System tools | 9.8k | 1.0% |
| MCP tools | 672 | 0.1% |
| MCP server instructions | 717 | 0.1% |
| MCP tools (deferred) | 32.6k | 3.3% |
| System tools (deferred) | 14.2k | 1.4% |
| Memory files | 490 | 0.0% |
| Skills | 2.4k | 0.2% |
| Messages | 10 | 0.0% |
| Free space | 950.3k | 95.0% |
| Autocompact buffer | 33k | 3.3% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__claude_ai_Claude_Docs__batch | claude_ai_Claude_Docs | 152 |
| mcp__claude_ai_Claude_Docs__create | claude_ai_Claude_Docs | 236 |
| mcp__claude_ai_Claude_Docs__delete | claude_ai_Claude_Docs | 344 |
| mcp__claude_ai_Claude_Docs__export | claude_ai_Claude_Docs | 465 |
| mcp__claude_ai_Claude_Docs__guide | claude_ai_Claude_Docs | 193 |
| mcp__claude_ai_Claude_Docs__query | claude_ai_Claude_Docs | 168 |
| mcp__claude_ai_Claude_Docs__read | claude_ai_Claude_Docs | 300 |
| mcp__claude_ai_Claude_Docs__update | claude_ai_Claude_Docs | 327 |
| mcp__claude_ai_Google_Drive__copy_file | claude_ai_Google_Drive | 563 |
| mcp__claude_ai_Google_Drive__create_file | claude_ai_Google_Drive | 1.4k |
| mcp__claude_ai_Google_Drive__download_file_content | claude_ai_Google_Drive | 476 |
| mcp__claude_ai_Google_Drive__get_file_metadata | claude_ai_Google_Drive | 616 |
| mcp__claude_ai_Google_Drive__get_file_permissions | claude_ai_Google_Drive | 135 |
| mcp__claude_ai_Google_Drive__get_shared_drive_metadata | claude_ai_Google_Drive | 196 |
| mcp__claude_ai_Google_Drive__list_file_revisions | claude_ai_Google_Drive | 180 |
| mcp__claude_ai_Google_Drive__list_recent_files | claude_ai_Google_Drive | 709 |
| mcp__claude_ai_Google_Drive__list_shared_drives | claude_ai_Google_Drive | 369 |
| mcp__claude_ai_Google_Drive__read_file_content | claude_ai_Google_Drive | 1k |
| mcp__claude_ai_Google_Drive__search_files | claude_ai_Google_Drive | 2.1k |
| mcp__claude_ai_Google_Drive__share_file | claude_ai_Google_Drive | 905 |
| mcp__claude_ai_Google_Drive__trash_file | claude_ai_Google_Drive | 157 |
| mcp__claude_ai_Google_Drive__update_file | claude_ai_Google_Drive | 1.5k |
| mcp__MCP_DOCKER__add_comment_to_pending_review | MCP_DOCKER | 600 |
| mcp__MCP_DOCKER__add_issue_comment | MCP_DOCKER | 490 |
| mcp__MCP_DOCKER__add_reply_to_pull_request_comment | MCP_DOCKER | 454 |
| mcp__MCP_DOCKER__assign_copilot_to_issue | MCP_DOCKER | 429 |
| mcp__MCP_DOCKER__code-mode | MCP_DOCKER | 278 |
| mcp__MCP_DOCKER__create_branch | MCP_DOCKER | 194 |
| mcp__MCP_DOCKER__create_or_update_file | MCP_DOCKER | 656 |
| mcp__MCP_DOCKER__create_pull_request | MCP_DOCKER | 348 |
| mcp__MCP_DOCKER__create_repository | MCP_DOCKER | 263 |
| mcp__MCP_DOCKER__delete_file | MCP_DOCKER | 227 |
| mcp__MCP_DOCKER__fork_repository | MCP_DOCKER | 170 |
| mcp__MCP_DOCKER__get_commit | MCP_DOCKER | 414 |
| mcp__MCP_DOCKER__get_file_contents | MCP_DOCKER | 448 |
| mcp__MCP_DOCKER__get_label | MCP_DOCKER | 165 |
| mcp__MCP_DOCKER__get_latest_release | MCP_DOCKER | 134 |
| mcp__MCP_DOCKER__get_me | MCP_DOCKER | 106 |
| mcp__MCP_DOCKER__get_release_by_tag | MCP_DOCKER | 168 |
| mcp__MCP_DOCKER__get_tag | MCP_DOCKER | 157 |
| mcp__MCP_DOCKER__get_team_members | MCP_DOCKER | 159 |
| mcp__MCP_DOCKER__get_teams | MCP_DOCKER | 128 |
| mcp__MCP_DOCKER__issue_read | MCP_DOCKER | 544 |
| mcp__MCP_DOCKER__issue_write | MCP_DOCKER | 1.4k |
| mcp__MCP_DOCKER__list_branches | MCP_DOCKER | 210 |
| mcp__MCP_DOCKER__list_commits | MCP_DOCKER | 653 |
| mcp__MCP_DOCKER__list_issue_fields | MCP_DOCKER | 299 |
| mcp__MCP_DOCKER__list_issue_types | MCP_DOCKER | 230 |
| mcp__MCP_DOCKER__list_issues | MCP_DOCKER | 918 |
| mcp__MCP_DOCKER__list_pull_requests | MCP_DOCKER | 641 |
| mcp__MCP_DOCKER__list_releases | MCP_DOCKER | 358 |
| mcp__MCP_DOCKER__list_repository_collaborators | MCP_DOCKER | 397 |
| mcp__MCP_DOCKER__list_tags | MCP_DOCKER | 208 |
| mcp__MCP_DOCKER__mcp-activate-profile | MCP_DOCKER | 152 |
| mcp__MCP_DOCKER__mcp-add | MCP_DOCKER | 184 |
| mcp__MCP_DOCKER__mcp-config-set | MCP_DOCKER | 243 |
| mcp__MCP_DOCKER__mcp-create-profile | MCP_DOCKER | 174 |
| mcp__MCP_DOCKER__mcp-exec | MCP_DOCKER | 154 |
| mcp__MCP_DOCKER__mcp-find | MCP_DOCKER | 288 |
| mcp__MCP_DOCKER__mcp-remove | MCP_DOCKER | 121 |
| mcp__MCP_DOCKER__merge_pull_request | MCP_DOCKER | 302 |
| mcp__MCP_DOCKER__pull_request_read | MCP_DOCKER | 1k |
| mcp__MCP_DOCKER__pull_request_review_write | MCP_DOCKER | 852 |
| mcp__MCP_DOCKER__push_files | MCP_DOCKER | 327 |
| mcp__MCP_DOCKER__request_copilot_review | MCP_DOCKER | 208 |
| mcp__MCP_DOCKER__search_code | MCP_DOCKER | 607 |
| mcp__MCP_DOCKER__search_commits | MCP_DOCKER | 580 |
| mcp__MCP_DOCKER__search_issues | MCP_DOCKER | 765 |
| mcp__MCP_DOCKER__search_pull_requests | MCP_DOCKER | 705 |
| mcp__MCP_DOCKER__search_repositories | MCP_DOCKER | 488 |
| mcp__MCP_DOCKER__search_users | MCP_DOCKER | 342 |
| mcp__MCP_DOCKER__sub_issue_write | MCP_DOCKER | 608 |
| mcp__MCP_DOCKER__update_issue_comment | MCP_DOCKER | 275 |
| mcp__MCP_DOCKER__update_pull_request | MCP_DOCKER | 398 |
| mcp__MCP_DOCKER__update_pull_request_branch | MCP_DOCKER | 221 |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| User | C:\Users\Nev\.claude\CLAUDE.md | 215 |
| User | C:\Users\Nev\.claude\RTK.md | 151 |
| AutoMem | C:\Users\Nev\.claude\projects\C--Users-Nev-Observibility-Proxy\memory\MEMORY.md | 124 |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| gepeto | User | < 20 |
| pinokio | User | < 20 |
| watch:watch | Plugin (watch) | ~120 |
| dataviz | Built-in | < 20 |
| artifact-design | Built-in | ~70 |
| artifact-diagramming | Built-in | ~70 |
| artifact-capabilities | Built-in | ~250 |
| update-config | Built-in | ~240 |
| keybindings-help | Built-in | < 20 |
| code-review | Built-in | ~400 |
| simplify | Built-in | < 20 |
| fewer-permission-prompts | Built-in | < 20 |
| loop | Built-in | < 20 |
| schedule | Built-in | < 20 |
| claude-api | Built-in | ~390 |
| run | Built-in | < 20 |
| plugin-authoring | Built-in | < 20 |
| init | Built-in | < 20 |
| security-review | Built-in | ~30 |
| built-in-browser | claude.ai sync | < 20 |
| chrome-browser | claude.ai sync | < 20 |
| computer-use | claude.ai sync | < 20 |
| deep-research | claude.ai sync | ~200 |
| docs | claude.ai sync | ~340 |
| docx | claude.ai sync | < 20 |
| google-workspace | claude.ai sync | < 20 |
| import-memory | claude.ai sync | < 20 |
| morning | claude.ai sync | < 20 |
| pdf | claude.ai sync | < 20 |
| pptx | claude.ai sync | < 20 |
| skill-creator | claude.ai sync | ~120 |
| xlsx | claude.ai sync | < 20 |

