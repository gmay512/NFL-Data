import type { SupabaseClient } from '@supabase/supabase-js'
import type { AnalyticsFilters, AnalyticsPreset, AnalyticsSnapshot } from './analytics-core'
import type { LlamaCompletion, LlamaStreamEvent } from './llama-client'

export type AnalysisMessage = {
  id: number
  role: 'assistant' | 'user'
  content: string
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number | null
  createdAt: string
}

export type AnalysisSessionSummary = {
  id: string
  title: string
  preset: AnalyticsPreset
  filters: AnalyticsFilters
  model: string
  createdAt: string
  updatedAt: string
}

export type AnalysisSession = AnalysisSessionSummary & {
  context: AnalyticsSnapshot
  messages: AnalysisMessage[]
}

export interface AnalysisStore {
  list(): Promise<AnalysisSessionSummary[]>
  get(id: string): Promise<AnalysisSession | null>
  saveInitial(input: {
    title: string
    preset: AnalyticsPreset
    filters: AnalyticsFilters
    context: AnalyticsSnapshot
    model: string
    prompt: string
    completion: LlamaCompletion
  }): Promise<AnalysisSession>
  appendExchange(
    id: string,
    question: string,
    completion: Extract<LlamaStreamEvent, { type: 'complete' }>,
  ): Promise<void>
  rename(id: string, title: string): Promise<AnalysisSessionSummary | null>
  delete(id: string): Promise<boolean>
}

type SessionRow = {
  id: string
  title: string
  preset_type: AnalyticsPreset
  filter_snapshot: AnalyticsFilters
  context_snapshot: AnalyticsSnapshot
  model_name: string
  created_at: string
  updated_at: string
}

type SessionSummaryRow = Omit<SessionRow, 'context_snapshot'>

type MessageRow = {
  id: number
  role: 'assistant' | 'user'
  content: string
  input_tokens: number | null
  output_tokens: number | null
  latency_ms: number | null
  created_at: string
}

function summary(row: SessionSummaryRow): AnalysisSessionSummary {
  return {
    id: row.id,
    title: row.title,
    preset: row.preset_type,
    filters: row.filter_snapshot,
    model: row.model_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function message(row: MessageRow): AnalysisMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    latencyMs: row.latency_ms,
    createdAt: row.created_at,
  }
}

function throwError(error: { message: string } | null) {
  if (error) throw new Error(error.message)
}

export function createAnalysisStore(client: SupabaseClient): AnalysisStore {
  const store: AnalysisStore = {
    async list() {
      const { data, error } = await client
        .from('analysis_sessions')
        .select('id,title,preset_type,filter_snapshot,model_name,created_at,updated_at')
        .order('updated_at', { ascending: false })
        .limit(100)
      throwError(error)
      return ((data ?? []) as SessionSummaryRow[]).map(summary)
    },

    async get(id) {
      const { data: sessionData, error: sessionError } = await client
        .from('analysis_sessions')
        .select('id,title,preset_type,filter_snapshot,context_snapshot,model_name,created_at,updated_at')
        .eq('id', id)
        .maybeSingle()
      throwError(sessionError)
      if (!sessionData) return null

      const { data: messageData, error: messageError } = await client
        .from('analysis_messages')
        .select('id,role,content,input_tokens,output_tokens,latency_ms,created_at')
        .eq('session_id', id)
        .order('id')
      throwError(messageError)

      const row = sessionData as SessionRow
      return {
        ...summary(row),
        context: row.context_snapshot,
        messages: ((messageData ?? []) as MessageRow[]).map(message),
      }
    },

    async saveInitial(input) {
      const { data, error } = await client
        .from('analysis_sessions')
        .insert({
          title: input.title,
          preset_type: input.preset,
          filter_snapshot: input.filters,
          context_snapshot: input.context,
          model_name: input.model,
        })
        .select('id,title,preset_type,filter_snapshot,context_snapshot,model_name,created_at,updated_at')
        .single()
      throwError(error)
      const row = data as SessionRow

      const { error: messagesError } = await client.from('analysis_messages').insert([
        { session_id: row.id, role: 'user', content: input.prompt },
        {
          session_id: row.id,
          role: 'assistant',
          content: input.completion.content,
          input_tokens: input.completion.usage?.promptTokens ?? null,
          output_tokens: input.completion.usage?.completionTokens ?? null,
          latency_ms: input.completion.latencyMs,
        },
      ])
      if (messagesError) {
        const { error: cleanupError } = await client.from('analysis_sessions').delete().eq('id', row.id)
        if (cleanupError) {
          throw new Error(`${messagesError.message}; cleanup failed: ${cleanupError.message}`)
        }
        throw new Error(messagesError.message)
      }

      const saved = await store.get(row.id)
      if (!saved) throw new Error('Saved analysis session could not be reloaded.')
      return saved
    },

    async appendExchange(id, question, completion) {
      const { error } = await client.from('analysis_messages').insert([
        { session_id: id, role: 'user', content: question },
        {
          session_id: id,
          role: 'assistant',
          content: completion.content,
          input_tokens: completion.usage?.promptTokens ?? null,
          output_tokens: completion.usage?.completionTokens ?? null,
          latency_ms: completion.latencyMs,
        },
      ])
      throwError(error)
    },

    async rename(id, title) {
      const { data, error } = await client
        .from('analysis_sessions')
        .update({ title })
        .eq('id', id)
        .select('id,title,preset_type,filter_snapshot,model_name,created_at,updated_at')
        .maybeSingle()
      throwError(error)
      return data ? summary(data as SessionSummaryRow) : null
    },

    async delete(id) {
      const { data, error } = await client
        .from('analysis_sessions')
        .delete()
        .eq('id', id)
        .select('id')
      throwError(error)
      return (data ?? []).length > 0
    },
  }
  return store
}
