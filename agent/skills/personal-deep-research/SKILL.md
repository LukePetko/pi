---
name: personal-deep-research
description: Autonomous deep research workflow with one upfront intake, broad source discovery, evidence grading, subagent cross-checking, and Markdown reports saved to Lukas's personal KB. Use when the user says /deep-research, deep research, research this deeply, investigate options, compare solutions, find best approach, or asks for a cited report across web, papers, OSS, forums, and local code.
---

# Deep Research

## Contract

Run like Claude/ChatGPT Deep Research: ask intake questions once at the
start, then work autonomously. Search broadly, verify claims, compare options,
and produce both console output and a durable Markdown report.

Default save root: `/Users/lukaspetko/.pi-knowledge/research/`.
Also link each report into the matching project folder under the personal KB.

## Intake: ask once, then proceed

Ask only this form unless the request is genuinely impossible without more data:

1. Research question / decision to make:
2. Context: current project/codebase? constraints? existing attempts?
3. Depth: `quick`, `standard`, or `deep` (default: `deep`)
4. Output emphasis: decision memo, implementation plan, market/library
   comparison, bug diagnosis, or broad research report (default: auto-detect)
5. Hard requirements / disallowed options:
6. Deadline / recency preference:

After the user answers, do not keep interrupting. If ambiguity remains, state
assumptions in the report.

## Depth levels

- `quick`: 5-10 strong sources, one pass, concise recommendation.
- `standard`: 15-30 sources, compare options, check docs/issues/forums/source.
- `deep`: broad search across web, papers, docs, OSS repos, forums, issue
  trackers, benchmarks, and local code when relevant. Use subagents for
  independent research/review.

## Source strategy

Use context-mode for noisy exploration.

1. Frame hypotheses and search angles.
2. Web search with varied queries: official docs, papers/arXiv/Scholar-like
   terms, GitHub/source, forums/Reddit/StackOverflow/HN, benchmarks, and
   failure cases.
3. Fetch/index important docs with `ctx_fetch_and_index`; search indexed
   content with `ctx_search`.
4. Use `code_search` for library/API examples and OSS implementation clues.
5. If local codebase matters, use LSP/AST/context-mode recon before conclusions.
6. Prefer primary sources: official docs, source code, release notes, papers,
   and maintainer comments. Use forums for lived experience, not as sole
   authority.

## Subagents

Use subagents when depth is `deep` or the decision is high-stakes. First run
`subagent({ action: "list" })`; only use executable, non-disabled agents.

Recommended routing:

- `researcher`: independent web/source research brief.
- `scout`: local codebase recon, if current repo matters.
- `reviewer` or `oracle`: skepticism pass on reasoning, source quality, and
  missing alternatives.
- `delegate`: targeted narrow tasks when builtin specialists are insufficient.

Reject janky output. If a subagent gives unsupported, vague, or uncited claims,
treat it as hints only and verify independently.

## Evidence rules

- Every major claim needs a citation or explicit label: `inference`,
  `low confidence`, or `needs validation`.
- Separate facts from recommendations.
- Include source quality notes: primary/secondary/anecdotal, date/recency, and
  possible bias.
- Prefer links to exact docs/pages/issues/source files. For code claims,
  include GitHub permalinks when available.
- Mention conflicting evidence and why the recommendation still wins.

## Report format

Save Markdown and also print both short summary and long report to console.

Required sections:

```md
---
title: "<research title>"
type: research-report
project: "<project slug>"
date: "YYYY-MM-DD"
depth: "quick|standard|deep"
tags: [research]
---

# <Title>

## Short summary
- Decision/recommendation:
- Why:
- Best next action:

## Question and assumptions

## Recommendation

## Options compared
| Option | Pros | Cons | Evidence | Fit |

## Findings

## Implementation / next steps

## Risks and unknowns

## Sources
| Source | Type | Date | What it supports | Confidence |

## Search log
- Queries/search angles used
- Rejected sources/options and why
```

## Saving reports

1. Treat `/Users/lukaspetko/.pi-knowledge` as `<KB_ROOT>`.
2. Slug topic and project: lowercase, hyphenated.
3. Main file: `<KB_ROOT>/research/YYYY-MM-DD-<topic-slug>.md`.
4. Project link/copy:
   - Ensure `<KB_ROOT>/projects/<project-slug>/research/` exists.
   - Add a symlink if safe. Otherwise, add a small Markdown pointer file named
     `YYYY-MM-DD-<topic-slug>.md` linking to the main report.
5. If project slug is unclear, use current directory basename.

Use native `write`/`edit` for report files. Do not use ctx tools for writes.

## Final response

Return:

1. Short summary.
2. Long report content or clearly structured excerpt if huge.
3. Saved paths:
   - main report path
   - project-linked report path
4. Note: `Review with /diff if you want to inspect file changes.`
