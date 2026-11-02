# AI patterns we follow, and where they come from

Every AI capability in Product Journey follows a pattern a company has published and measured. This page maps each one to its source and to our code, and says what is built and what is designed. Numbers in the "Their result" column are the companies' own published figures; ours come from `npm run eval`.

| Capability | Pattern we follow | Source | Their result | Our implementation | Status |
| --- | --- | --- | --- | --- | --- |
| RAG for on-call engineers | Retrieve from internal knowledge, answer only from what was retrieved, cite the source | [Uber Genie](https://www.uber.com/blog/genie-ubers-gen-ai-on-call-copilot) | 70,000+ questions, ~13,000 engineering hours saved | `agent/src/rag/knowledge.ts`: past incidents, runbooks and approved investigations; evidence kind `kb_similar`, cited as E-ids and checked by the verifier | Built (dummy ServiceNow records until connected) |
| Chunking by document shape | Keep units whole (tables, records, sections); add metadata | [Uber enhanced agentic RAG](https://www.uber.com/en-GB/blog/enhanced-agentic-rag/) | +27% acceptable answers, -60% incorrect advice | `rag/chunk.ts`: one chunk per incident, runbooks by heading with overlap, logs as error windows | Built |
| Hybrid search | Keep keyword search beside vector search; merge results | [Spotify podcast search](https://engineering.atspotify.com/introducing-natural-language-search-for-podcast-episodes/), Uber enhanced RAG (BM25 + vector) | Natural-language queries answered that keyword search missed | `rag/search.ts`: BM25 + vector top 30 each, reciprocal rank fusion, product boost; approved investigations first, then the best runbook | Built |
| Vector store | Approximate nearest-neighbour index next to metadata | Spotify (Vespa ANN) | | In-memory cosine store; pgvector schema with HNSW and full-text index in `PGVECTOR_DDL` | Built (in memory); pgvector designed |
| Embeddings | Domain or general embedding model, same model for queries and documents | Spotify (fine-tuned sentence encoder), Uber Genie (OpenAI embeddings) | | Any OpenAI-compatible `/embeddings` endpoint (`EMBEDDINGS_*`); local hashing embedder when none is set | Built |
| Long-term memory | Save outcomes and plans outside the context; resume from saved state | [Anthropic research system](https://www.anthropic.com/engineering/multi-agent-research-system) | | Approved investigations are chunked into the knowledge base as precedent; rejected ones are not | Built |
| Stateful agent with approval | Controllable graph, step traces, human checkpoint | [Klarna on LangGraph](https://www.langchain.com/blog/customers-klarna) | Resolution time -80%, work of 700 staff | `agent/src/graph.ts` (server) and `web.ts` (card): LangGraph steps, loop, pause for approval | Built |
| Validate, then retry within limits | Each step validated; failures go back with the errors until pass or retry limit | [Airbnb test migration](https://www.infoq.com/news/2025/03/airbnb-llm-test-migration/) | 3,500 files in ~6 weeks vs 1.5 years | Verify step with 6 checks; failing runs loop back for evidence at most twice | Built |
| Small focused agent steps | Separate steps narrow the problem; a person confirms | [Uber QueryGPT](https://www.uber.com/en-us/blog/query-gpt/) | ~10 min to ~3 min per query | Classify, plan, gather, hypothesize, verify, recommend, approve | Built |
| Two-tier guardrail | Cheap check on every answer; model judge only when it flags | [DoorDash Dasher support](https://careersatdoordash.com/?p=12568) | Hallucinations -90%, severe compliance issues -99% | `agent/src/guard.ts`: tier 1 checks figures, links and instruction-like text; tier 2 judge; failure falls back to rules | Built |
| Prompt-injection defence | Tool output is data, never instructions | OWASP LLM Top 10 | | Instruction-like lines stripped from tool output and flagged; evidence wrapped in `<evidence>` blocks; system prompt says not to follow them | Built (pattern-based, not complete) |
| Golden-set evaluation in CI | Graded cases before launch, regression tests after | [Morgan Stanley](https://openai.com/index/morgan-stanley/), Uber enhanced RAG (100+ question set) | Document access 20% to 80%, 98% adoption | `agent/eval/`: 28 investigations over 12 rules plus adversarial and injection cases, 8 metrics with pass bars, run in CI | Built |
| Measure each component | Report each part's effect on recall and errors | [LinkedIn SQL Bot](https://trino.io/assets/blog/trino-summit-2024/trino-summit-2024-linkedin-ai.pdf) | Rerankers +9% table recall | Separate retrieval metrics (precedent hit@5, runbook hit@3) from answer metrics | Built |
| Tracing every agent step | Step-by-step traces to find where behaviour goes wrong | Klarna (LangSmith) | | `agent/src/trace.ts`: spans per run, step, model call and tool call with OpenTelemetry GenAI attribute names; OTLP/HTTP export to Dynatrace or any collector | Built |
| Feedback loop in production | Users rate answers; ratings feed a dashboard | Uber Genie (48.9% rated helpful) | | Every Approve or Reject logged to `data/agent-feedback.jsonl`; `GET /api/agent/feedback` gives approval rate overall and per rule | Built |
| Use vendor agents, don't rebuild them | Ask the specialist agent that already exists; cite its answer | [Dynatrace Intelligence agents](https://www.dynatrace.com/news/press-release/dynatrace-introduces-domain-specific-agents/), ServiceNow Now Assist | | Evidence `vendor_assessment` through their MCP servers (Dynatrace MCP, ServiceNow MCP Server Console) | Built, opt-in (tool names to confirm per tenant) |
| Hand code fixes to a coding agent | Issue in, draft PR out, a person reviews | [GitHub Copilot coding agent](https://github.blog/changelog/2025-09-25-copilot-coding-agent-is-now-generally-available/) | | After approval, an issue assigned to Copilot through the GitHub MCP server; write allowlisted; dry run in the card | Built, opt-in |
| Managed retrieval and guardrails | Use the platform's RAG and safety services in production | Azure AI Search, Amazon Bedrock Knowledge Bases, Amazon Bedrock Guardrails | | `providers.ts`: `RAG_PROVIDER`, `GUARDRAIL_PROVIDER`; the built-in versions remain the offline fallback | Built (Azure AI Search tested against a stand-in; Bedrock not run against AWS) |
| Multi-agent supervisor | Lead agent with parallel specialists | Anthropic research system | +90.2% on their test, ~15x tokens | Runtime, delivery, code and cost specialists | Designed: added only if evaluation shows the single agent falls short |
| Durable checkpoints | Survive restarts while waiting for a person | LangGraph Postgres checkpointer | | MemorySaver today | Designed (Phase A) |

## Current evaluation results

From `npm run eval` on the demo data (rules path, no model):

| Metric | Score | Pass bar |
| --- | --- | --- |
| Evidence coverage | 99.3% | 90% |
| Verified investigations | 100% | 90% |
| Citation validity | 100% | 100% |
| Action grounding | 100% | 100% |
| Past-incident precedent in top 5 | 90.9% | 80% |
| Right runbook in top 3 | 100% | 90% |
| Adversarial cases caught | 100% (3 of 3) | 100% |
| Injection lines removed | 100% (5 of 5) | 100% |

What these numbers do and don't show: they come from the dummy data and our own adversarial cases, so they prove the pipeline behaves as designed, not how it performs on real incidents. The first run of the runbook metric scored 17.9%: near-identical past incidents crowded the runbook out, which led to the runbook slot in hybrid search. That is the point of the gate.

The memory test found a second gap the same way: an approved investigation was stored but ranked below raw tickets with near-identical wording. Human-approved outcomes now take the first slot, and CI checks the loop end to end (approve one compile failure, investigate a later one, expect the approved run as cited evidence).
