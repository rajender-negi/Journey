# AI Capabilities Interview Guide

Nov 2, 2026 · Rajender Negi

## How to use this guide

Every capability below is set out so you can answer in three parts: **what it is**, **when to use it and when not to**, and **where I used it**. The third part is what separates an architect from someone who read about it.

**One-line pitch to open with:** "I built Product Journey, an agentic AI platform that follows each product's changes from merge to verified production, with Dynatrace as the hub and the ServiceNow CMDB as product identity. A LangGraph agent investigates failures through MCP, checks its own findings against the evidence and waits for human approval. Rules decide what is wrong; AI explains it and ranks the fixes."

**Status labels used in this guide:**

- **Built:** in Product Journey today.
- **Designed:** planned, with a clear design you can explain.
- **Know:** not in the project; know it well enough to discuss trade-offs.

## Real companies first: one example per capability

Learn each idea from a company that shipped it, then see how Product Journey uses it in the sections below. Every example links to the company's own write-up.

| Capability | Company and system | What they did | The lesson |
| --- | --- | --- | --- |
| LLM basics: latency, cost, streaming | [Amazon Rufus](https://spectrum.ieee.org/amazon-rufus) (shopping assistant, Oct 2024) | Streams the start of an answer while the rest is generated; continuous batching and Amazon's own Trainium and Inferentia chips to serve millions of shoppers at once | At scale, serving cost and latency are design problems, not afterthoughts |
| Prompting and context | [Uber QueryGPT](https://www.uber.com/en-us/blog/query-gpt/) (text to SQL, Sep 2024) | Puts sample SQL in the prompt as examples; a column-prune step removes irrelevant schema columns, cutting tokens, cost and latency | What you leave out of the prompt matters as much as what you put in |
| Embeddings and vector search | [Spotify podcast search](https://engineering.atspotify.com/introducing-natural-language-search-for-podcast-episodes/) (Mar 2022) | Fine-tuned a sentence-embedding model; episode vectors searched in Vespa; kept keyword search alongside because vectors miss exact terms | Vector search adds to keyword search; it rarely replaces it |
| Chunking | [Uber enhanced agentic RAG](https://www.uber.com/en-GB/blog/enhanced-agentic-rag/) (May 2025) | Standard PDF loaders broke tables, so tables became markdown and metadata kept each table in one chunk; summaries and keywords added as metadata we | Bad chunking silently ruins retrieval; fix the documents before the model |
| RAG | [Uber Genie](https://www.uber.com/blog/genie-ubers-gen-ai-on-call-copilot) (on-call Slack copilot, Oct 2024) | Wiki and internal Q&A chunked, embedded and stored in Uber's own vector database; answers only from retrieved text, with source links. 70,000+ questions answered, about 13,000 engineering hours saved | Closest real example to Product Journey: AI that helps on-call engineers |
| Agents and tool use | [Uber QueryGPT](https://www.uber.com/en-us/blog/query-gpt/) | Separate intent, table and column-prune agents narrow the problem step by step; users confirm tables before generation. Query time about 10 min down to about 3 | Small, focused agent steps with a human check beat one big prompt |
| LangGraph | [Uber enhanced agentic RAG](https://www.uber.com/en-GB/blog/enhanced-agentic-rag/) | Agents before and after retrieval, orchestrated with LangGraph. 27% more acceptable answers, 60% less incorrect advice on a 100+ question test set | A framework earns its place once the flow has several agent steps |
| MCP | [Block and Apollo](https://www.anthropic.com/news/model-context-protocol) (Nov 2024) | Named as first adopters when Anthropic released MCP; Zed, Replit, Codeium and Sourcegraph built it into developer tools | One standard way to give AI tools access to company systems |
| Memory and state | [Anthropic research system](https://www.anthropic.com/engineering/multi-agent-research-system) (Jun 2025) | The lead agent saves its plan to memory because long context gets cut; agents resume from checkpoints after errors instead of restarting | Long-running agents need saved state, exactly what a checkpointer gives |
| Multi-agent | [Anthropic research system](https://www.anthropic.com/engineering/multi-agent-research-system) | A lead agent spawns parallel sub-agents. 90.2% better than one agent on their research test, but about 15 times the tokens of a chat | Multi-agent buys quality with cost; prove the gain first |
| Evaluation | [Morgan Stanley](https://openai.com/index/morgan-stanley/) (advisor assistant) | Every use case tested before launch; advisors graded answers; later daily regression tests for compliance. Document access 20% to 80%, 98%+ of advisor teams use it | In regulated firms, evaluation is what gets AI approved |
| Feedback and monitoring | [Uber Genie](https://www.uber.com/blog/genie-ubers-gen-ai-on-call-copilot) | Users rate each answer in Slack; ratings flow through Kafka to a dashboard; 48.9% rated helpful; an AI judge checks hallucination and relevance | Measure in production, not just before launch |
| Guardrails | [DoorDash Dasher support](https://careersatdoordash.com/?p=12568) (Sep 2024) | Two-tier check on every answer: a cheap similarity check first, then an AI reviewer for grounding and policy. Hallucinations down 90%, severe compliance issues down 99% | Cheap checks first, expensive checks only when needed |
| RAG or fine-tuning | [Uber Genie](https://www.uber.com/blog/genie-ubers-gen-ai-on-call-copilot) vs [Amazon Rufus](https://spectrum.ieee.org/amazon-rufus) | Uber chose RAG: no training data needed, faster to launch. Amazon trained Rufus on its catalog, reviews and Q&A from the start | RAG by default; a custom model only with huge domain data and scale |

**How Product Journey maps:** Genie is the closest twin (AI for on-call engineers). Product Journey adds what Genie's write-up doesn't describe: live evidence from Dynatrace and CI/CD, a verifier, and human approval before action.

**Three more best-in-class references worth quoting**

| Capability | Company and system | What they did | Why it is the best reference |
| --- | --- | --- | --- |
| LangGraph at scale + evaluation | [Klarna AI assistant](https://www.langchain.com/blog/customers-klarna) (Feb 2025) | Multi-agent assistant for payments and refunds on LangGraph, traced and evaluated in LangSmith, critical cases built test-first. 2.5 million conversations, work equal to 700 staff, resolution time down 80% | The largest public LangGraph production story, and it pairs the framework with evaluation |
| Agent loop: validate, then retry | [Airbnb test migration](https://www.infoq.com/news/2025/03/airbnb-llm-test-migration/) (Mar 2025) | 3,500 test files moved in about 6 weeks instead of an estimated 1.5 years: a step-by-step pipeline where each step is validated and errors go back to the model until it passes or hits a retry limit | The clearest proof that "check, then retry with limits" beats clever prompting |
| Measuring each part of retrieval | [LinkedIn SQL Bot](https://trino.io/assets/blog/trino-summit-2024/trino-summit-2024-linkedin-ai.pdf) (Trino Summit 2024) | Text to SQL using a knowledge graph, vector stores and rerankers, plus a self-correction agent. Reported each part's effect: rerankers +9% table recall, self-correction cut hallucination 14 points | Shows how to justify every component with a number |

## How Product Journey follows these patterns

Every pattern above is now in the app, so each answer can name the company you learned it from and the code where you applied it. All of it runs in CI on every change; the repo's `docs/AI-PATTERNS.md` has the same table.

| Capability | We follow | What we built | Status |
| --- | --- | --- | --- |
| RAG | Uber Genie | Past incidents, runbooks and approved investigations searched by the agent; matches come back as cited evidence (`kb_similar`) | Built |
| Chunking | Uber enhanced RAG | One chunk per incident, runbooks by heading with overlap, logs as error windows | Built |
| Hybrid search and vector store | Spotify, Uber enhanced RAG | BM25 + vector, reciprocal rank fusion, time and product filters; in-memory vectors, pgvector schema with HNSW ready | Built (pgvector designed) |
| Embeddings | Uber Genie, Spotify | Any OpenAI-compatible embedding model by setting; a local model-free embedder for the phone card and tests | Built |
| Long-term memory | Anthropic research system | Approved investigations are added to the knowledge base and rank first for the next similar failure | Built |
| Stateful agent with approval | Klarna on LangGraph | LangGraph graph with a check-and-retry loop and a pause for approval, on the server and in the card | Built |
| Validate, then retry | Airbnb test migration | 6 verification checks; failing runs go back for evidence at most twice | Built |
| Two-tier guardrail | DoorDash | Cheap check on every AI recommendation; an AI judge only when it flags; failure falls back to rules | Built |
| Prompt-injection defence | OWASP LLM Top 10 | Instruction-like lines removed from tool output and flagged; evidence marked as data | Built (pattern-based) |
| Golden-set evaluation in CI | Morgan Stanley, Uber | 28 investigations plus adversarial and injection cases, 8 metrics with pass bars; CI fails below them | Built |
| Measure each component | LinkedIn SQL Bot | Retrieval scored separately from answers (precedent hit@5, runbook hit@3) | Built |
| Tracing | Klarna | A span per run, step, model call and tool call with OpenTelemetry GenAI names; exported to Dynatrace over OTLP | Built |
| Feedback loop | Uber Genie | Every Approve or Reject logged; approval rate overall and per rule | Built |
| Multi-agent | Anthropic research system | Runtime, delivery, code and cost specialists | Designed, only if evaluation shows a gain |

**Evaluation results on the demo data:** evidence coverage 99.3%, verified investigations 100%, citation validity 100%, action grounding 100%, past-incident precedent in the top 5 90.9%, right runbook in the top 3 100%, adversarial cases caught 3 of 3, injection lines removed 5 of 5.

**The story to tell:** the evaluation gate found two real problems on its first runs. Near-identical tickets pushed the right runbook out of the top 3 (17.9% at first), and an approved investigation ranked below raw tickets. Both were fixed by reserving result slots, and both now have tests. That is evaluation doing its job, and it's a stronger interview answer than a perfect score.

**Be precise about one thing:** these numbers come from dummy data in ServiceNow's real format and from our own adversarial cases. They prove the pipeline behaves as designed, not how it performs on your real incidents.

## 1. LLM fundamentals

A large language model predicts the next token from everything in its context window. Everything else in this guide is about giving it the right context, constraining what it returns and checking the result.

| Concept | What to say | Where I used it |
| --- | --- | --- |
| Token | Unit of text the model reads and bills by, roughly 3 to 4 characters of English | Evidence capped per item so prompts stay small (Built) |
| Context window | Maximum tokens per call, input plus output. Bigger is not better: cost, latency and attention all degrade | Compact evidence pack instead of raw logs (Built) |
| Temperature | Randomness of sampling. Low for extraction and JSON, higher for drafting | Low by design: structured outputs only |
| Model tiers | Fast and cheap for routing and classification, strong for reasoning | Quick tier for planning, default tier for hypothesis and recommendation in the card (Built) |
| Reasoning models | Think before answering. Better on multi-step problems, slower and dearer | Worth it for hypothesis, not for planning (Know) |
| Hallucination | Fluent but unsupported output. Reduced by grounding, never eliminated | Verifier rejects uncited claims and invented figures (Built) |
| Latency | Time to first token plus generation time. Streaming hides the first, not the second | Live step progress in the card (Built) |
| Cost | Input tokens + output tokens per call, times calls per task. Agents multiply calls | Max 2 verification rounds caps cost per run (Built) |

**Interview line:** "The model is the least deterministic part of the system, so I design everything around it to be deterministic: what goes in, what shape comes out, and how the output is checked."

## 2. Prompting and structured output

In production, a prompt is an interface contract, not a chat message: fixed instructions, the data, and an exact output shape that code validates.

- **System prompt:** standing rules (role, what not to do, tone). Mine: use only the evidence provided, cite evidence ids, no invented services, numbers or causes. (Built)
- **Few-shot examples:** 1 to 3 worked examples steer format and judgement better than more instructions. Useful when outputs drift. (Know)
- **Structured output:** ask for JSON matching a schema, then validate it in code. Two ways:
  - Native: the provider enforces the schema (tool calling or JSON schema mode). LangChain `withStructuredOutput`. (Built, server)
  - Parse and validate: ask for JSON, parse it, check it with zod (TypeScript) or pydantic (Python), fall back on failure. (Built, card)
- **Tool or function calling:** the model returns a request to call a named function with arguments; your code runs it and returns the result. The basis of every agent.
- **Prompt versioning:** prompts are code. Version them, test them against an evaluation set, review changes like code. (Designed)

**Pitfalls to name:** trusting free text, putting untrusted data next to instructions without marking it as data, and prompts so long the key rule gets lost.

**Interview line:** "Every model reply in my system goes through a schema. If it doesn't parse, or it cites a rule that isn't in the evidence, it is dropped and the rules path takes over."

## 3. Embeddings, vector databases and chunking

An embedding turns text into a list of numbers (a vector) so that similar meanings sit close together; a vector database finds the nearest vectors to a query fast. Chunking decides what one vector stands for, and it matters more than which database you pick.

**Embeddings**

- A model maps text to a vector of a few hundred to a few thousand dimensions. Similarity is usually cosine similarity.
- Query and documents must use the same embedding model. Changing models means re-embedding everything.
- Options: OpenAI, Voyage, Cohere, Bedrock Titan, Azure OpenAI, or open-source models such as the BGE and E5 families for self-hosting.

**Vector databases**

| Option | Pick it when |
| --- | --- |
| pgvector (Postgres) | You already run Postgres and want one store for vectors, metadata, agent checkpoints and memory. My default |
| OpenSearch / Elasticsearch | The company already runs it and needs keyword + vector (hybrid) search at scale |
| Pinecone, Weaviate, Qdrant, Milvus | Very large collections, managed service, or vector-first features |
| In-memory (FAISS, Chroma) | Prototypes and tests only |

- **Index types:** HNSW (graph, fast and accurate, more memory, the common default) and IVF (clusters, less memory, needs tuning). Both are approximate: speed is traded for a little recall.
- **Metadata filters:** product id, service, date, source. Filter before or during search so one team's data never answers another team's question.

**Chunking strategies**

| Strategy | Typical size | Use for |
| --- | --- | --- |
| Fixed size with overlap | 500 to 800 tokens, 10 to 20% overlap | Plain long text, a safe default |
| By structure (headings, sections) | One section | Runbooks, postmortems, docs |
| One record per chunk | Whole record | Incidents, tickets, approved investigations |
| Semantic (split where meaning shifts) | Varies | Mixed long documents |
| Code-aware (functions, classes) | One function or class | Source code, using a parser such as tree-sitter |
| Window around an anchor | ±40 lines | Logs: only the lines around the error |

- **Parent-child chunking:** search small chunks for precision, return the larger parent for context.
- **Rule of thumb:** a chunk should answer one question on its own. Too small loses context, too large dilutes the match.

**Where I used it:** built in Product Journey: one chunk per incident record, runbooks by heading with overlap, logs as error windows; BM25 plus vector search merged by reciprocal rank fusion, filtered by time and product. Vectors in memory today, with a pgvector schema (HNSW index) ready for production. (Built)

**Interview line:** "I don't put metrics in a vector database. Structured data goes to DQL and rules; vectors are for unstructured text such as incidents and runbooks."

## 4. RAG end to end

Retrieval-augmented generation fetches relevant text at question time and gives it to the model as context, so answers rest on your data instead of the model's memory. Most RAG failures are retrieval failures, not model failures.

**Two pipelines**

1. **Ingestion (offline):** load sources, clean, chunk, attach metadata, embed, store. Re-run on change; track which version of each document is indexed.
2. **Query (online):** rewrite the question if needed, filter by metadata, hybrid search, rerank, keep the top 3 to 8, build the prompt with citations, generate, check the answer cites what it used.

**Techniques to know**

- **Hybrid search:** keyword (BM25) plus vector, merged (for example reciprocal rank fusion). Keyword catches exact ids, error codes and service names that vectors miss.
- **Reranking:** a cross-encoder rescores the top 20 to 50 results against the question. Usually the biggest quality gain for the least effort.
- **Query rewriting:** expand acronyms, split multi-part questions, or generate a hypothetical answer and search with that (HyDE).
- **Citations:** each chunk gets an id; the answer must cite ids; uncited claims are flagged.
- **GraphRAG:** builds an entity graph (service calls service, owned by team) for questions about relationships. Useful when answers span many linked documents.
- **Agentic RAG:** the agent decides when and what to retrieve, possibly several times, as one tool among many.

**Failure modes**

| Symptom | Usual cause | Fix |
| --- | --- | --- |
| Right document exists, not found | Bad chunking, no keyword search | Hybrid search, better chunks |
| Found but ranked low | No reranker | Add a reranker |
| Wrong team's data in the answer | No metadata filter | Filter by product or tenant |
| Out-of-date answer | Stale index | Incremental re-indexing, date filter |
| Confident answer, no support | Weak grounding instructions | Require citations, verify them |

**Where I used it:** Built in Product Journey as a new evidence type, `kb_similar`. Past incidents and runbooks come back as cited evidence ids like any other evidence, so the existing verifier checks them unchanged.

**Interview line:** "I measure retrieval separately from generation. If the right incident isn't in the top 5, no prompt will fix the answer."

## 5. Agents and tool use

An agent is a model in a loop: it decides the next action, calls a tool, reads the result and repeats until done. Use one only when the steps can't be fixed in advance; otherwise a fixed workflow is cheaper, faster and easier to test.

&#91;embedded content: Product Journey agent · 7 steps, 1 loop, 1 human gate\]

Three steps use AI (plan additions, hypothesize, recommend); rules handle the rest, and nothing happens until a person approves.

**Patterns**

- **ReAct:** reason, act (tool call), observe, repeat. The classic open loop. Flexible but hard to bound.
- **Plan and execute:** plan all steps first, then run them. Easier to review and limit.
- **Workflow with AI steps:** fixed steps, AI only where judgement is needed. My choice for Product Journey: classify, plan evidence, gather, hypothesize, verify, recommend, approve. (Built)
- **Reflection or self-check:** a second pass critiques the first. Better done by deterministic checks where possible; mine are 6 rule-based verification checks. (Built)
- **Human in the loop:** the run pauses for approval before any action with side effects. (Built)

**What makes an agent production-grade**

| Concern | What I did |
| --- | --- |
| Bounded | Max 2 verification rounds; 45 s per model call |
| Grounded | Every claim cites an evidence id; checked in code |
| Safe tools | Read-only by default; write tools need an allowlist; Dynatrace never written |
| Recoverable | Every AI step has a rules fallback, so a run always completes |
| Observable | A step log and a full trace per run |

**When not to use an agent:** the steps are known (use a workflow), the answer is a lookup (use a query), or a wrong action is costly and can't be reviewed (keep a human in the loop).

**Interview line:** "My agent is a workflow with three AI steps, not an open-ended loop. That is a deliberate choice: it is bounded, testable and every run ends with a person approving."

## 6. Frameworks compared

Frameworks save plumbing, not thinking. Pick by what the problem needs most: control over a stateful flow, retrieval, multi-agent conversation, or fit with a vendor stack.

| Framework | What it is for | Pick it when | Watch out for |
| --- | --- | --- | --- |
| LangChain | Model adapters, prompts, output parsers, retrievers, tools | You want one interface over many models and common building blocks | Abstraction layers; use the parts you need |
| LangGraph | Stateful agent graphs: nodes, edges, loops, checkpoints, interrupts | Long-running agents, human approval, resume after restart | Version changes; keep node logic outside it |
| LlamaIndex | Data ingestion and retrieval for RAG | Retrieval is the main problem | Less suited to complex control flow |
| CrewAI | Role-based multi-agent teams | Quick multi-agent prototypes | Harder to bound and test |
| AutoGen (Microsoft) | Agents that converse to solve tasks | Research-style multi-agent conversation | Unbounded conversations, cost |
| Semantic Kernel | Microsoft SDK for AI plugins in .NET, Python, Java | Microsoft and Azure enterprise stacks | Smaller open ecosystem |
| Vendor agent SDKs (Claude Agent SDK, OpenAI Agents SDK, Bedrock Agents, Vertex AI agents) | Agents tightly integrated with one provider or cloud | You are committed to that provider | Lock-in |
| No framework | Plain code and a state machine | Simple, fixed flows | You rebuild persistence and tracing yourself |

**What I used and why:** LangGraph for the agent graph (approval pause, check-and-retry loop, streaming steps), LangChain for model adapters and structured output, and plain TypeScript functions for all agent logic, so the framework stays replaceable in about a day. (Built)

**Interview line:** "I keep the business logic framework-free and use the framework for what it is good at: state, persistence and the approval pause."

## 7. MCP and A2A

MCP (Model Context Protocol) is an open standard for connecting AI applications to tools and data: build a server once, and any MCP client (Cursor, Claude, your own app) can use it. A2A (Agent2Agent) is a separate protocol for agents to call other agents.

**MCP essentials**

- **Roles:** host app (Cursor, Claude, Product Journey) runs a client per server; the server exposes capabilities.
- **What a server exposes:** tools (actions the model can call), resources (data it can read), prompts (reusable templates).
- **Transports:** stdio (local process), Streamable HTTP (remote, the current standard), SSE (older remote transport).
- **Governance, where architects add value:** who may connect which server, which tools are allowed, read-only by default, tokens never in prompts, every call logged, rate and size limits.

**A2A essentials:** each agent publishes a card describing its skills; other agents send it tasks and get results back. Useful when separate teams or vendors own separate agents. MCP connects an agent to tools; A2A connects agents to agents.

**Where I used it**

- Built the Dynatrace MCP server integration with Cursor, Kiro, VS Code and Claude, and drove organisation-wide adoption under portal identity and access policy. (Built, at work)
- Product Journey is an MCP client of the same servers Cursor uses: stdio, Streamable HTTP and SSE; tool names resolved per server version; write-looking tools refused unless allowlisted; Dynatrace never written to; every call time-limited, size-capped and audited. (Built)
- Exposing Product Journey itself as an MCP server (`get_journey`, `explain_failure`, `risk_for_pr`). (Designed)

**Interview line:** "MCP solved the integration problem; the hard part now is governance. I treat MCP servers like any production API: identity, least privilege, audit."

## 8. Memory and state

A model remembers nothing between calls; anything an agent "remembers" is state your system saves and feeds back. Separate three kinds and store each deliberately.

| Kind | What it holds | Lives | Example in Product Journey |
| --- | --- | --- | --- |
| Working state | The current run: evidence, hypothesis, step reached | Checkpointer, per run | LangGraph state with evidence E0, E1… (Built, in memory) |
| Durable execution | The same state, surviving restarts and long waits | Postgres checkpointer | A run paused at 2 am resumes when someone approves at 9 am (Designed) |
| Long-term memory | Facts and outcomes across runs | Database or vector store | Approved investigations become searchable precedent, ranked first (Built) |

- **Conversation memory** for chat: keep recent turns, summarise older ones, drop what doesn't matter. Watch the token cost.
- **Risks:** stale memory treated as fact, one user's memory leaking to another, memory that can't be deleted. Scope it per tenant and let people remove it.

**Interview line:** "My agent's working state is checkpointed per run, so a human can approve hours later. Long-term memory comes from approved outcomes only, so the system learns from decisions people stood behind."

## 9. Multi-agent patterns

Several agents help when work splits into independent parts that can run in parallel or need different tools; otherwise they add cost, latency and failure points. Anthropic's research system shows both sides: 90.2% better on its own test, at about 15 times the tokens of a chat.

| Pattern | How it works | Good for |
| --- | --- | --- |
| Supervisor (orchestrator and workers) | One lead agent plans and hands sub-tasks to specialists, then combines results | Research, investigations across several systems |
| Hierarchical | Supervisors of supervisors | Very large tasks; rarely needed |
| Sequential pipeline | Agent A's output feeds agent B | Fixed stages, such as Uber QueryGPT's intent, table and column agents |
| Swarm or handoff | Agents pass control to each other as the task changes | Customer support routing |
| Debate or critic | One agent proposes, another critiques | Quality checks, when rules can't do the checking |

**Rules to state in an interview**

- Start with one agent; split only when evaluation shows a gain.
- Give each agent a narrow job, its own tools and a clear output shape.
- Bound everything: depth, rounds, tokens, time.

**Where I'd use it:** a supervisor with runtime (Dynatrace), delivery (GitHub, Argo CD), code-review and cost specialists, running in parallel. Not built on purpose: the single agent isn't yet shown to fall short. (Designed)

## 10. Evaluation

Evaluation is the unit test of AI: a fixed set of cases, a scoring method and a pass bar, run on every change. It is the first thing a senior interviewer probes, and the easiest way to stand out.

**Building blocks**

- **Golden set:** 50 to 200 real cases with expected outcomes, written or reviewed by experts. Uber's enhanced RAG used 100+ questions with expert answers.
- **Scoring methods:** exact checks (did it cite the right rule id), code checks (valid JSON, no invented numbers), AI judge with a rubric (accuracy, grounding, completeness), and human review of a sample.
- **AI judge calibration:** compare the judge with human grades before trusting it; keep humans spot-checking.
- **Run it in CI:** a prompt or model change that drops the score fails the build.

| What to measure | RAG | Agent |
| --- | --- | --- |
| Did it find the right material | Retrieval recall at top 5, precision | Right evidence gathered |
| Is the answer supported | Faithfulness to retrieved text | Citations exist and match claims |
| Is it right | Answer correctness vs golden answer | Correct root cause, accepted actions |
| Is it efficient | Latency, tokens | Steps, tool calls, cost per run |
| Is it used | Thumbs up rate | Approve vs reject rate |

**Where I used it:** 54 automated tests in CI include the agent end to end on all 12 failure types, and a test that a wrong story is caught ("citations match claims"). (Built) A golden set of 28 investigations plus adversarial and injection cases, scored on 8 metrics with pass bars, runs in CI on every change; approve and reject decisions are logged with an approval-rate API. (Built)

**Interview line:** "I don't ship a prompt change without running the evaluation set. The approve-reject rate from humans is my production metric."

## 11. LLMOps and AI observability

Running AI in production needs the same discipline as running services: traces, metrics, cost and alerts, plus quality signals that ordinary services don't have. This is your strongest ground as an observability architect.

- **Tracing:** one trace per request or agent run, a span per step, model call and tool call, with prompt version, model, tokens, latency and outcome.
- **Standards:** OpenTelemetry GenAI semantic conventions define common attribute names for model calls, so traces can go to Dynatrace, Datadog, Langfuse or LangSmith.
- **Cost tracking:** tokens and cost per run, per product, per team; budgets and alerts when a run exceeds them.
- **Quality in production:** user feedback (Uber Genie: 48.9% rated helpful), AI judge on a sample, approve-reject rate, fallback rate.
- **Model routing and caching:** a fast model for simple steps, a strong one for reasoning; cache repeated answers; a fallback model when the main one fails.
- **Release practice:** prompt and model versions, canary rollout of prompt changes, roll back on score drop.

**Where I used it:** a step log per agent run, an audit trail of every MCP call, per-call time limits, and model tiers per step in the card. (Built) A trace per run with a span for every step, model call and tool call, using OpenTelemetry GenAI attribute names and exported over OTLP to Dynatrace when configured. (Built) Real token cost per run is next. (Designed)

**Interview line:** "An agent is a distributed system with a non-deterministic component. I trace it like one: every step, every tool call, every token, in the same observability platform as the services it investigates."

## 12. Guardrails and AI security

Guardrails are checks before and after the model, plus limits on what tools it can use. Treat the model as an untrusted component: it can be misled by the data it reads.

| Risk (OWASP LLM Top 10 themes) | What it means | Control | In Product Journey |
| --- | --- | --- | --- |
| Prompt injection | Text in a log, PR or document tells the model to do something else | Mark tool output as data, strip instruction-like text, never let it choose tools | Instruction-like lines stripped from tool output and flagged; evidence wrapped as data (Built, pattern-based) |
| Sensitive data disclosure | Secrets or personal data reach the model or the user | Redact before the model; mask in output | Secrets masked in findings; tokens stay on the server (Built) |
| Excessive agency | The agent can do more than it should | Least-privilege tools, write allowlist, human approval | Read-only by default, Dynatrace never written, approve before action (Built) |
| Insecure output handling | Model output used unchecked as code, SQL or a command | Schema validation; templates, not free-form queries | zod schemas; DQL from templates only (Built) |
| Misinformation (hallucination) | Confident, unsupported claims | Grounding, citations, verification | 6 verification checks (Built) |
| Unbounded consumption | Runaway loops or cost | Limits on rounds, time, tokens | 2 rounds, 45 s per call, size caps (Built) |
| Supply chain | Untrusted models, packages or MCP servers | Pinned versions, approved registries, review | Actions pinned to commit SHAs, Dependabot (Built) |

**Real example:** DoorDash checks every support answer twice, a cheap similarity check first and an AI reviewer only when that flags it. Hallucinations fell 90% and severe compliance issues 99%.

**Interview line:** "I assume the model will be wrong or manipulated sometimes, so it never has the last word: schemas, verification, least privilege and a human approve before anything changes."

## 13. Prompting vs RAG vs fine-tuning

Try them in this order: better prompts first, then RAG for knowledge, then fine-tuning only for behaviour or format the first two can't fix. Uber chose RAG for Genie because it needed no curated training data and launched faster.

| Approach | Changes | Fixes | Cost and effort | Pick it when |
| --- | --- | --- | --- | --- |
| Prompting | Instructions and examples | Format, tone, simple rules | Lowest; minutes to change | Always first |
| RAG | What the model sees at question time | Missing or changing knowledge, citations | Medium; an index to maintain | Knowledge changes often or must be cited |
| Fine-tuning | The model's weights | Consistent style, narrow task skill, shorter prompts | High; training data, retraining, evaluation | Stable task, lots of good examples, high volume |
| Distillation | A small model trained on a big model's outputs | Cost and latency at scale | High upfront, cheap to run | One narrow task at very high volume |
| Training your own model | Everything | Deep domain fit | Very high | Huge domain data and scale, as with Amazon Rufus |

**Common trap:** fine-tuning to add knowledge. It teaches behaviour, not facts that change; use RAG for facts.

**Where I stand:** Product Journey uses prompting and schemas today, RAG next for incidents and runbooks, and no fine-tuning, because rules plus retrieval give more control at lower cost.

## 14. Architecture principles for AI systems

These eight principles are the spine of a Principal-level answer. Each one has a concrete example in Product Journey.

1. **Deterministic first.** Rules decide what is wrong; AI explains and ranks. Same input, same finding, every time.
2. **Ground everything.** No claim without evidence; every claim cites an evidence id that code checks.
3. **Constrain the output.** Schemas on every model reply; drop what doesn't fit.
4. **Always have a fallback.** Every AI step has a rules version, so the system works with no model at all.
5. **Least privilege for tools.** Read-only by default, writes on an allowlist, Dynatrace never written.
6. **Human approval for action.** The agent prepares; a person decides.
7. **Budget cost and latency.** Bounded rounds, time limits per call, model tier per step.
8. **Keep the framework replaceable.** Business logic in plain functions; frameworks only for state, persistence and wiring.

**Trade-offs to be ready for**

- Accuracy vs latency: a stronger model or more retrieval is slower. Answer: route by step.
- Autonomy vs control: more autonomy cuts MTTR but raises risk. Answer: approval now, auto-approve low-risk actions later once evaluation supports it.
- Build vs buy: agentic SRE products exist (Resolve AI, Traversal, Dynatrace's own agents). Answer: build only the novel part, the product-level journey keyed on the CMDB, on top of what the company already runs.

## 15. Interview questions with model answers

Each answer follows the pattern: the principle, then where you applied it. Say them in your own words; keep each under two minutes.

1. **"Walk me through an agentic system you designed."** Product Journey's investigation agent: classify by rules, plan evidence (rules set the minimum, AI may add), gather through MCP, hypothesize with citations, verify with 6 checks, loop back at most twice, recommend, then pause for human approval. LangGraph holds the state and the pause.
2. **"How do you stop hallucinations?"** I don't rely on the model to be right. Every claim cites an evidence id; code checks that the ids exist, returned data and match the source named; numbers must appear in the evidence. Failing runs are marked "not fully verified". DoorDash's two-tier guardrail is the same idea at scale.
3. **"When would you not use an agent?"** When the steps are known in advance, use a workflow; when the answer is a lookup, use a query. My agent is a workflow with three AI steps for exactly that reason.
4. **"Why LangGraph?"** For durable state and the approval pause: a run can wait hours and resume after a restart with a Postgres checkpointer. Logic stays in plain functions, so it is replaceable in about a day.
5. **"Design RAG for on-call engineers."** Sources: incidents, postmortems, runbooks. Chunk by record and by heading, logs as error windows. Hybrid search in pgvector or OpenSearch, filtered by product and service, reranked, top 5 with citations. Measure retrieval recall separately. Uber Genie is the reference: 70,000+ questions, about 13,000 hours saved.
6. **"How do you evaluate an AI system?"** A golden set of real cases, code checks plus an AI judge calibrated against humans, run in CI on every prompt or model change; in production, approve-reject rate and user feedback.
7. **"How do you govern MCP in an enterprise?"** Identity per user, least-privilege tool lists, read-only default, write allowlists, audit of every call, size and time limits. I did this for the Dynatrace MCP rollout across the organisation.
8. **"What does it cost and how do you control it?"** Tokens per step times steps per run. Bounded rounds, model tier per step, caching, and cost per run tracked in observability. Multi-agent can cost about 15 times a chat, so I add it only when evaluation shows a gain.
9. **"How would you secure an agent that reads logs?"** Treat tool output as untrusted data, strip instruction-like text, never let it choose tools, keep tools read-only and require approval for writes.
10. **"Build or buy?"** Buy the commodity (models, observability, agent SRE features in Dynatrace); build only what is unique: the product-level journey keyed on the CMDB and the rules that encode our delivery standards.

## 16. Glossary and 2-week study plan

| Term | One line |
| --- | --- |
| ANN | Approximate nearest neighbour search: fast vector search that trades a little accuracy for speed |
| BM25 | The standard keyword-ranking method; the keyword half of hybrid search |
| Checkpointer | Saves an agent's state after each step so it can pause and resume |
| Cosine similarity | How close two vectors point; the usual similarity score for embeddings |
| Cross-encoder reranker | A model that rescores query and document together; more accurate than vector search alone |
| Faithfulness | Whether an answer is supported by the retrieved text |
| Golden set | Fixed test cases with expected answers for evaluation |
| HNSW | The common graph-based vector index |
| HyDE | Search with a hypothetical answer instead of the question |
| Interrupt | LangGraph's pause for human input |
| ReAct | Reason, act, observe loop for agents |
| Reciprocal rank fusion | A simple way to merge keyword and vector results |
| Structured output | Model replies forced into a schema |

**Two-week plan**

- [ ] Days 1 to 2: read the Real companies table and the four Uber, Spotify and DoorDash write-ups in full.
- [ ] Days 3 to 4: sections 1 to 3; explain embeddings and chunking aloud without notes.
- [ ] Days 5 to 6: sections 4 to 6; draw the RAG pipeline and the agent flow on paper.
- [ ] Day 7: section 7; practise the MCP governance answer using your Dynatrace rollout.
- [ ] Days 8 to 9: sections 8 to 11; Anthropic's multi-agent write-up and Morgan Stanley's evaluation story.
- [ ] Day 10: sections 12 to 14; map each OWASP risk to a control.
- [ ] Days 11 to 12: answer the 10 questions in section 15 aloud, timed, two minutes each.
- [ ] Days 13 to 14: demo Product Journey end to end: a failure, Investigate, the verification checks, Approve.

## Sources

- [Genie: Uber's Gen AI on-call copilot](https://www.uber.com/blog/genie-ubers-gen-ai-on-call-copilot) (Oct 2024)
- [QueryGPT: natural language to SQL at Uber](https://www.uber.com/en-us/blog/query-gpt/) (Sep 2024)
- [Enhanced agentic RAG at Uber](https://www.uber.com/en-GB/blog/enhanced-agentic-rag/) (May 2025)
- [Introducing natural language search for podcast episodes, Spotify](https://engineering.atspotify.com/introducing-natural-language-search-for-podcast-episodes/) (Mar 2022)
- [Rufus under the hood, IEEE Spectrum](https://spectrum.ieee.org/amazon-rufus) (Oct 2024)
- [Path to high-quality LLM-based Dasher support automation, DoorDash](https://careersatdoordash.com/?p=12568) (Sep 2024)
- [How we built our multi-agent research system, Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system) (Jun 2025)
- [Introducing the Model Context Protocol, Anthropic](https://www.anthropic.com/news/model-context-protocol) (Nov 2024)
- [Morgan Stanley and OpenAI](https://openai.com/index/morgan-stanley/)
