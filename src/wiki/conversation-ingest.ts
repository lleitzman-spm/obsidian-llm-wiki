// Conversation Ingestor — extract Wiki knowledge from chat conversations.
// Extracted from WikiEngine.

import {
  EngineContext,
  SourceAnalysis,
  IngestReport,
} from '../types';
import { PROMPTS } from '../prompts';
import { slugify } from '../core/slug';
import { parseJsonResponse } from '../core/json';
import { cleanMarkdownResponse } from '../core/markdown';
import { applySectionLabels } from './system-prompts';
import { renderTemplate } from '../core/template-renderer';
import { resolveModelForTask } from '../core/model-resolver';
import { getText } from '../core/i18n';
import { UNIVERSAL_LINK_CONSTRAINTS } from './prompts/constraints';
import { TOKENS_CONVERSATION_EXTRACTION, TOKENS_CONVERSATION_PAGE, TOKENS_PAGE_GENERATION, TOKENS_QUERY_SAVE_DEDUP } from '../constants';
import { PageFactory } from './page-factory';
import { SourceAnalysisLLMSchema, ConversationDedupStatusLLMSchema } from '../llm-sdk/output-schemas';
import { callLlm } from '../core/llm-dispatch';
import { guardGeneratedWikiLinks, ensureGeneratedPageLinks, type GeneratedLinkPageRef } from '../core/generated-link-guard';
import type { PathWriteLease } from './engine-internals/path-write-queue';

export interface ConversationOrchestration {
  ensureWikiStructure: () => Promise<void>;
  apiDelay: (ms?: number) => Promise<void>;
  /**
   * The optional lease is supplied only by a write-gate aware production
   * orchestrator. Legacy callers may keep the one/two argument functions.
   * Conversation ingest never calls a lease-aware function without first
   * entering `withWriteGate`, which prevents nested path-lock deadlocks.
   */
  generateIndex: (held?: PathWriteLease) => Promise<void>;
  updateLog: (operation: string, analysis: SourceAnalysis, held?: PathWriteLease) => Promise<void>;
  /** Acquire index + log paths once and pass the held lease to both writers. */
  withWriteGate?: <T>(paths: readonly string[], operation: (held: PathWriteLease) => Promise<T>) => Promise<T>;
}

export interface ConversationHistory {
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
  }>;
}

export function formatConversation(history: ConversationHistory): string {
  return history.messages.map(msg => {
    const role = msg.role === 'user' ? '👤 User' : '🤖 Wiki';
    const time = new Date(msg.timestamp).toLocaleTimeString();
    return `### ${role} (${time})\n\n${msg.content}\n\n---\n`;
  }).join('\n');
}

export class ConversationIngestor {
  constructor(
    private ctx: EngineContext,
    private pageFactory: PageFactory,
    private orch: ConversationOrchestration
  ) {}

  async ingestConversation(history: {
    messages: Array<{
      role: 'user' | 'assistant';
      content: string;
      timestamp: number;
    }>;
  }): Promise<IngestReport> {
    const startTime = Date.now();
    const client = this.ctx.getClient();
    if (!client) {
      throw new Error('LLM Client not initialized');
    }

    console.debug('=== Starting conversation extraction ===');
    this.ctx.onProgress?.(getText(this.ctx.settings.language, 'convAnalyzing'));

    const actualDate = new Date().toISOString().split('T')[0];
    console.debug('[System time]', actualDate);

    const indexPath = `${this.ctx.settings.wikiFolder}/index.md`;
    const existingWikiIndex = await this.ctx.tryReadFile(indexPath) || 'Wiki is empty';
    console.debug('[Wiki索引]', existingWikiIndex ? '已读取' : '为空');

    const conversationText = formatConversation(history);

    if (existingWikiIndex !== 'Wiki is empty') {
      this.ctx.onProgress?.(getText(this.ctx.settings.language, 'convCheckingExisting'));
      try {
        const dedupResult = await this.checkDedup(existingWikiIndex, conversationText);
        // Issue #398: emit a console.warn so DevTools shows the LLM's actual
        // dedup verdict when the user clicks Save and gets a 0/0/0 notice.
        // The notice itself is surfaced via QueryView.saveToWiki (see
        // QueryView-class.ts — `report.errorMessage`).
        console.debug('[conversation-ingest] dedup verdict:', dedupResult);
        if (dedupResult === 'fully_redundant') {
          console.warn('[conversation-ingest] save skipped: dedup=fully_redundant');
          this.ctx.onProgress?.(getText(this.ctx.settings.language, 'convAlreadyExists'));
          return {
            sourceFile: `Conversation: ${history.messages[0]?.content?.substring(0, 50) || 'unknown'}`,
            createdPages: [],
            updatedPages: [],
            entitiesCreated: 0,
            conceptsCreated: 0,
            failedItems: [],
            contradictionsFound: 0,
            success: true,
            errorMessage: 'Knowledge already exists in Wiki',
          };
        }
      } catch (error) {
        console.debug('Dedup check failed, proceeding with save:', error);
      }
    }

    const analysisPrompt = `You are a Wiki knowledge extraction assistant.

Existing Wiki Index (use this as reference for entity/concept names):
${existingWikiIndex}

User conversation with AI:
${conversationText}

Convert this conversation into structured Wiki pages.

Focus on:
1. Extracting key knowledge points (not full conversation log)
2. Identifying core concepts and entities discussed
3. Summarizing conversation topic and conclusions
4. Entity/concept names should match existing Wiki pages if possible

Actual conversation date: ${actualDate} (use this, do not generate date yourself)

Output JSON format:
{
  "source_title": "Semantic Topic Title (no date, describe the discussion topic)",
  "summary": "Conversation topic summary",
  "entities": [
    {
      "name": "Short Reference Name",
      "type": "person|organization|project|product|event|place|other",
      "summary": "Entity information summary",
      "mentions_in_source": ["Specific mentions in conversation"]
    }
  ],
  "concepts": [
    {
      "name": "Concept Name",
      "type": "theory|method|field|phenomenon|standard|term|other",
      "summary": "Concept definition",
      "mentions_in_source": ["Specific mentions in conversation"],
      "related_concepts": ["Related Concept 1", "Related Concept 2"]
    }
  ],
  "key_points": ["Point 1", "Point 2"],
  "created_pages": [],
  "updated_pages": []
}

CRITICAL RULES:
- source_title: Semantic title describing discussion topic (NOT date-based generic title)
- entity.name: Choose or extract appropriate name from Wiki index (maintain consistency with existing Wiki)
- concept.name: Same principle - reference Wiki index for concept names
- mentions_in_source: REQUIRED field - list actual mentions in conversation text
- DO NOT output mentions_with_provenance for conversations — the page-factory writes Mentions programmatically with a single citation pointing to the conversation summary page (Issue #244).
- If no entities/concepts found, use empty arrays [] (never omit the field)
- Names should be suitable for [[wiki-links]] referencing (judge appropriate naming based on Wiki index)`;

    const analysisArgs = {
      task: 'conversation-extract' as const,
      model: resolveModelForTask(this.ctx.settings, 'ingest'),
      max_tokens: TOKENS_CONVERSATION_EXTRACTION,
      system: await this.ctx.buildSystemPrompt('conversation'),
      messages: [{
        role: 'user' as const,
        content: analysisPrompt
      }],
      response_format: { type: 'json_object' as const, schema: SourceAnalysisLLMSchema },
      ...(this.ctx.settings.disableThinking ? { enableThinking: false } : {}),
    };
    // v1.26.3 PATCH Issue #443 expanded scope: typed-output path. Same
    // schema (SourceAnalysisLLMSchema) as source-analyzer extract.
    const analysisText = await callLlm(client, analysisArgs);

    const parsed = await parseJsonResponse(analysisText, async (malformedJson: string) => {
      const repairPrompt = `Fix the following malformed JSON. Only fix JSON syntax errors (unescaped quotes, trailing commas, missing brackets). Do NOT change any values or content. Output ONLY the fixed JSON, no other text.\n\n${malformedJson}`;
      const repairArgs = {
        task: 'conversation-extract-retry' as const,
        model: resolveModelForTask(this.ctx.settings, 'ingest'),
        max_tokens: TOKENS_PAGE_GENERATION,
        system: await this.ctx.buildSystemPrompt('conversation'),
        messages: [{ role: 'user' as const, content: repairPrompt }],
        response_format: { type: 'json_object' as const, schema: SourceAnalysisLLMSchema },
        ...(this.ctx.settings.disableThinking ? { enableThinking: false } : {}),
      };
      return callLlm(client, repairArgs);
    }) as SourceAnalysis | null;
    if (!parsed) {
      throw new Error('Conversation analysis JSON parsing failed');
    }

    // The page lists are bookkeeping we own, not content the model reports.
    // Always discard model-supplied values: accepting a fabricated path here
    // would make the index/log and the final provenance pass claim a page that
    // was never written.
    parsed.created_pages = [];
    parsed.updated_pages = [];
    parsed.entities = parsed.entities ?? [];
    parsed.concepts = parsed.concepts ?? [];

    console.debug('[LLM分析结果]', parsed);
    console.debug('[生成的标题]', parsed.source_title);

    this.ctx.onProgress?.(getText(this.ctx.settings.language, 'convCreatingSummary'));
    await this.orch.ensureWikiStructure();

    const preserveCase = this.ctx.settings.slugCase === 'preserve';
    const semanticSlug = slugify(parsed.source_title, preserveCase);
    const summaryPath = `${this.ctx.settings.wikiFolder}/sources/${semanticSlug}.md`;
    console.debug('[Semantic file path]', summaryPath);

    // Build planned paths before summary so the LLM can reference them
    const convPlannedPaths: string[] = [summaryPath];
    for (const entity of parsed.entities) {
      convPlannedPaths.push(`${this.ctx.settings.wikiFolder}/entities/${slugify(entity.name, preserveCase)}.md`);
    }
    for (const concept of parsed.concepts) {
      convPlannedPaths.push(`${this.ctx.settings.wikiFolder}/concepts/${slugify(concept.name, preserveCase)}.md`);
    }

    const createdPagesList = convPlannedPaths.length > 0
      ? convPlannedPaths.map(p => {
          const relPath = p.replace(this.ctx.settings.wikiFolder + '/', '').replace('.md', '');
          const name = relPath.split('/').pop() || relPath;
          return `- [[${relPath}|${name}]]`;
        }).join('\n')
      : '(none)';

    const tags = parsed.concepts.map(c => c.name).join(', ');

    const summaryPrompt = renderTemplate(PROMPTS.generateSummaryPage, {
      source_title: parsed.source_title,
      content: conversationText.substring(0, 500),
      analysis: JSON.stringify(parsed),
      created_pages_list: createdPagesList,
      source_file: `Conversation: ${parsed.source_title}`,
      date: actualDate,
      tags,
      constraints: UNIVERSAL_LINK_CONSTRAINTS,
    });

    const finalSummaryPrompt = applySectionLabels(summaryPrompt, this.ctx.settings);

    this.ctx.onProgress?.(getText(this.ctx.settings.language, 'convGeneratingSummary'));
    const summaryPageContent = await client.createMessage({
      task: 'conversation-page',
      model: resolveModelForTask(this.ctx.settings, 'ingest'),
      max_tokens: TOKENS_CONVERSATION_PAGE,
      system: await this.ctx.buildSystemPrompt('summary'),
      messages: [{ role: 'user', content: finalSummaryPrompt }],
      ...(this.ctx.settings.disableThinking ? { enableThinking: false } : {}),
    });

    const cleanedSummary = cleanMarkdownResponse(summaryPageContent);
    // The child paths are preflight candidates at this point, so the summary
    // may retain useful display labels for them during the child-write phase.
    // They are not authoritative: the final pass below removes any candidate
    // whose write failed and adds only verified paths. Unknown/fabricated
    // targets are still stripped before this first write.
    await this.writeGuardedFile(summaryPath, cleanedSummary, convPlannedPaths);
    parsed.created_pages.push(summaryPath);

    const actualPagePaths: string[] = [summaryPath];

    const failedItems: Array<{ type: 'entity' | 'concept'; name: string; reason: string }> = [];

    for (const entity of parsed.entities) {
      await this.orch.apiDelay();
      this.ctx.onProgress?.(
        getText(this.ctx.settings.language, 'convSavingEntity').replace('{name}', entity.name)
      );
      try {
        const entityResult = await this.pageFactory.createOrUpdateEntityPage(entity, parsed, { path: summaryPath, basename: semanticSlug }, convPlannedPaths);
        if (entityResult.path) {
          await this.verifyWrittenPage(entityResult.path, 'entity', entity.name);
          (entityResult.created ? parsed.created_pages : parsed.updated_pages)
            .push(entityResult.path);
          actualPagePaths.push(entityResult.path);
        } else {
          failedItems.push({
            type: 'entity',
            name: entity.name,
            reason: 'Page path resolution did not produce a writable path',
          });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`Conversation entity "${entity.name}" failed:`, error);
        failedItems.push({ type: 'entity', name: entity.name, reason });
      }
    }

    for (const concept of parsed.concepts) {
      await this.orch.apiDelay();
      this.ctx.onProgress?.(
        getText(this.ctx.settings.language, 'convSavingConcept').replace('{name}', concept.name)
      );
      try {
        const conceptResult = await this.pageFactory.createOrUpdateConceptPage(concept, parsed, { path: summaryPath, basename: semanticSlug }, convPlannedPaths);
        if (conceptResult.path) {
          await this.verifyWrittenPage(conceptResult.path, 'concept', concept.name);
          (conceptResult.created ? parsed.created_pages : parsed.updated_pages)
            .push(conceptResult.path);
          actualPagePaths.push(conceptResult.path);
        } else {
          failedItems.push({
            type: 'concept',
            name: concept.name,
            reason: 'Page path resolution did not produce a writable path',
          });
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`Conversation concept "${concept.name}" failed:`, error);
        failedItems.push({ type: 'concept', name: concept.name, reason });
      }
    }

    // Remove links to failed/preflight-only pages from every generated page,
    // then add exactly the paths that were verified on disk. This is the
    // authoritative reconciliation boundary for conversation ingest.
    await this.reconcileGeneratedPages(summaryPath, actualPagePaths, convPlannedPaths);

    this.ctx.onProgress?.(getText(this.ctx.settings.language, 'convGeneratingIndex'));
    parsed.contradictions = parsed.contradictions || [];
    await this.generateIndexAndLog(parsed);

    const entitiesCreated = parsed.created_pages.filter(p => p.includes('/entities/')).length;
    const conceptsCreated = parsed.created_pages.filter(p => p.includes('/concepts/')).length;

    const report: IngestReport = {
      sourceFile: `Conversation: ${parsed.source_title}`,
      createdPages: parsed.created_pages,
      updatedPages: parsed.updated_pages || [],
      entitiesCreated,
      conceptsCreated,
      failedItems,
      contradictionsFound: parsed.contradictions?.length || 0,
      success: failedItems.length === 0,
      ...(failedItems.length > 0
        ? { errorMessage: `Conversation ingest completed partially: ${failedItems.length} item(s) failed` }
        : {}),
      elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
    };

    console.debug('=== Conversation extraction complete ===');
    console.debug('Created pages:', parsed.created_pages);

    this.ctx.onDone?.(report);
    return report;
  }

  /**
   * Verify a PageFactory result before allowing it into provenance. A path
   * returned by a resolver is only a plan; it becomes authoritative after the
   * vault can read the page and the path remains in the expected namespace.
   */
  private async verifyWrittenPage(
    path: string,
    type: 'entity' | 'concept',
    name: string,
  ): Promise<void> {
    const folder = type === 'entity' ? 'entities' : 'concepts';
    const prefix = `${this.ctx.settings.wikiFolder}/${folder}/`;
    if (!path.startsWith(prefix) || !path.endsWith('.md')) {
      throw new Error(`Conversation ${type} "${name}" returned invalid page path: ${path}`);
    }
    if (await this.ctx.tryReadFile(path) === null) {
      throw new Error(`Conversation ${type} "${name}" returned a page path that was not written: ${path}`);
    }
  }

  private async existingGeneratedRefs(): Promise<GeneratedLinkPageRef[]> {
    const wikiPages = await this.ctx.getExistingWikiPages();
    const external = this.ctx.app.vault.getMarkdownFiles()
      .filter(file => !file.path.startsWith(`${this.ctx.settings.wikiFolder}/`))
      .map(file => ({ path: file.path, title: file.basename }));
    return [...wikiPages, ...external];
  }

  /** Guard one conversation-owned write, using an already-held lease when one exists. */
  private async writeGuardedFile(
    path: string,
    content: string,
    additionalPaths: string[],
  ): Promise<void> {
    const write = async (held?: PathWriteLease): Promise<void> => {
      const pages = await this.existingGeneratedRefs();
      const additionalPages = additionalPaths.map(pagePath => ({
        path: pagePath,
        title: pagePath.replace(/\.md$/i, '').split('/').pop() ?? pagePath,
      }));
      const guarded = guardGeneratedWikiLinks(content, {
        wikiFolder: this.ctx.settings.wikiFolder,
        pages,
        additionalPages,
      });
      if (held && this.ctx.createOrUpdateFileUnlocked) {
        await held.runRaw(path, () => this.ctx.createOrUpdateFileUnlocked!(path, guarded));
      } else {
        await this.ctx.createOrUpdateFile(path, guarded);
      }
    };

    // `createOrUpdateFile` already acquires this path. Only use a held/raw
    // lease when the context exposes the corresponding unlocked write API;
    // otherwise acquiring here and calling the public writer would deadlock.
    if (this.ctx.withPathWriteLocks && this.ctx.createOrUpdateFileUnlocked) {
      await this.ctx.withPathWriteLocks([path], held => write(held));
    } else {
      await write();
    }
  }

  /**
   * Re-read and reconcile every generated page after child writes finish.
   * Preflight candidates never enter `additionalPages`; only verified paths do.
   */
  private async reconcileGeneratedPages(
    summaryPath: string,
    actualPagePaths: string[],
    preflightPaths: string[] = [],
  ): Promise<void> {
    const uniquePaths = [...new Set(actualPagePaths)];
    const actualPathKeys = new Set(uniquePaths.map(path => path.toLowerCase()));
    const stalePreflightKeys = new Set(
      preflightPaths
        .filter(path => !actualPathKeys.has(path.toLowerCase()))
        .map(path => path.toLowerCase()),
    );
    const reconcile = async (held?: PathWriteLease): Promise<void> => {
      // A preflight path which was not returned by a verified write is not
      // allowed back in through the general existing-page index. This matters
      // when a stale file happens to occupy the old slug: it must not preserve
      // a dead/stale edge merely because that unrelated file exists.
      const pages = (await this.existingGeneratedRefs())
        .filter(page => !stalePreflightKeys.has(page.path.toLowerCase()));
      const actualRefs = uniquePaths.map(path => ({
        path,
        title: path.replace(/\.md$/i, '').split('/').pop() ?? path,
      }));
      for (const path of uniquePaths) {
        const current = await this.ctx.tryReadFile(path);
        if (current === null) continue;
        const guarded = guardGeneratedWikiLinks(current, {
          wikiFolder: this.ctx.settings.wikiFolder,
          pages,
          additionalPages: actualRefs,
        });
        const finalContent = path === summaryPath
          ? ensureGeneratedPageLinks(
            guarded,
            uniquePaths.filter(candidate => candidate !== summaryPath),
            this.ctx.settings.wikiFolder,
          )
          : guarded;
        if (finalContent === current) continue;
        if (held && this.ctx.createOrUpdateFileUnlocked) {
          await held.runRaw(path, () => this.ctx.createOrUpdateFileUnlocked!(path, finalContent));
        } else {
          await this.ctx.createOrUpdateFile(path, finalContent);
        }
      }
    };

    if (this.ctx.withPathWriteLocks && this.ctx.createOrUpdateFileUnlocked) {
      await this.ctx.withPathWriteLocks(uniquePaths, held => reconcile(held));
    } else {
      // The public writer supplies per-path serialization for legacy contexts.
      // This branch intentionally avoids wrapping it in another lock.
      await reconcile();
    }
  }

  /** Serialize index + log as one write-gate transaction when available. */
  private async generateIndexAndLog(parsed: SourceAnalysis): Promise<void> {
    const indexPath = `${this.ctx.settings.wikiFolder}/index.md`;
    const logPath = `${this.ctx.settings.wikiFolder}/log.md`;
    // Prefer the context's canonical multi-path lease when the orchestrator
    // exposes unlocked writers. Calling the public writer while this lease is
    // held would wait on itself forever, hence the explicit capability check.
    if (this.ctx.withPathWriteLocks && this.ctx.createOrUpdateFileUnlocked) {
      await this.ctx.withPathWriteLocks([indexPath, logPath], async held => {
        await this.orch.generateIndex(held);
        await this.orch.updateLog('conversation', parsed, held);
      });
      return;
    }
    // Some callers own a higher-level gate that binds both writers to the
    // lease internally. Keep that adapter for those callers.
    if (this.orch.withWriteGate) {
      await this.orch.withWriteGate([indexPath, logPath], async held => {
        await this.orch.generateIndex(held);
        await this.orch.updateLog('conversation', parsed, held);
      });
      return;
    }
    await this.orch.generateIndex();
    await this.orch.updateLog('conversation', parsed);
  }

  private async checkDedup(wikiIndex: string, conversationText: string): Promise<string> {
    const summary = conversationText.substring(0, 1500);
    const prompt = renderTemplate(PROMPTS.dedupCheck, {
      wiki_index: wikiIndex.substring(0, 3000),
      conversation_summary: summary,
    });

    const client = this.ctx.getClient();
    if (!client) throw new Error('LLM client not initialized');

    const dedupArgs = {
      task: 'conversation-save-dedup' as const,
      model: resolveModelForTask(this.ctx.settings, 'ingest'),
      max_tokens: TOKENS_QUERY_SAVE_DEDUP,
      system: await this.ctx.buildSystemPrompt('conversation'),
      messages: [{ role: 'user' as const, content: prompt }],
      // v1.26.3 PATCH Issue #443 expanded scope: typed-output path. Uses
      // ConversationDedupStatusLLMSchema ({status: string}) on the wire as
      // Tier 0 json_schema — LMStudio accepts, no parse-error fallback to
      // English welcome. Caller falls back to parseJsonResponse on legacy
      // clients without createMessageWithOutput.
      response_format: { type: 'json_object' as const, schema: ConversationDedupStatusLLMSchema },
      ...(this.ctx.settings.disableThinking ? { enableThinking: false } : {}),
    };
    const dedupText = await callLlm(client, dedupArgs);

    const parsed = await parseJsonResponse(dedupText) as { status?: string } | null;
    return parsed?.status || 'entirely_new';
  }
}
