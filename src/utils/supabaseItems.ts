import { supabase } from './supabaseClient';
import { ensureFSRSVocab, ensureFSRSGrammar } from './storage';
import type { VocabItem, GrammarItem, ReviewLog, UserRankData } from '../types';

export type ItemKind = 'vocab' | 'grammar';
export type AnyItem = VocabItem | GrammarItem;
export type ItemOf<K extends ItemKind> = K extends 'vocab' ? VocabItem : GrammarItem;

export const ITEM_TABLE: Record<ItemKind, 'vocab_items' | 'grammar_items'> = {
  vocab: 'vocab_items',
  grammar: 'grammar_items',
};
export const STUDY_TABLE = 'study_data';

export type ItemRow = {
  user_id: string;
  id: string;
  data: Record<string, unknown>;
  updated_at?: string;
};

export type StudyEntry = {
  state: number;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  scheduled_days: number;
  elapsed_days: number;
  learning_steps: number;
  reviewDate: string | null;
  last_review: string | null;
  next_review: string;
};

export type StudyMap = Record<string, StudyEntry>;

export type StudySnapshot = {
  user_id: string;
  vocab: StudyMap;
  grammar: StudyMap;
  progress: UserRankData | null;
  settings: Record<string, unknown>;
  history: ReviewLog[];
  updated_at?: string;
};

export type StudyRow = StudySnapshot;

const FSRS_KEYS = new Set([
  'stability', 'difficulty', 'reps', 'lapses', 'state', 'last_review', 'next_review',
  'reviewDate', 'elapsed_days', 'scheduled_days', 'learning_steps', 'interval',
  'repetition', 'easeFactor',
]);

const PAGE_SIZE = 1000;
const WRITE_CHUNK_ROWS = 200;
const WRITE_CHUNK_BYTES = 3_000_000;

export class SupabaseSyncError extends Error {
  constructor(public readonly action: string, public readonly cause?: unknown) {
    super(`Không thể ${action}: ${explainCause(cause)}`);
    this.name = 'SupabaseSyncError';
  }
}

function explainCause(cause: unknown): string {
  const err = (cause ?? {}) as { message?: string; code?: string };
  const message = err.message || String(cause ?? '');
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'mất kết nối mạng.';
  if (/fetch|network|load failed|timeout/i.test(message)) return 'không kết nối được Supabase, hãy kiểm tra mạng.';
  if (err.code === '42501' || /row-level security|permission denied/i.test(message)) return 'không có quyền ghi (RLS). Hãy đăng nhập lại.';
  if (/JWT|not signed in|chưa đăng nhập/i.test(message)) return 'phiên đăng nhập đã hết hạn, hãy đăng nhập lại.';
  return message || 'lỗi không xác định.';
}

export function describeSupabaseError(error: unknown): string {
  if (error instanceof SupabaseSyncError) return error.message;
  return `Lỗi Supabase: ${explainCause(error)}`;
}

function fail(action: string, cause: unknown): never {
  console.error('Supabase Error:', action, cause);
  throw new SupabaseSyncError(action, cause);
}

async function requireUserId(action: string): Promise<string> {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user?.id) fail(action, error ?? new Error('Chưa đăng nhập'));
    return data.user.id;
  } catch (error) {
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

export function newItemId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function withItemId<T extends { id?: string }>(item: T): T & { id: string } {
  return { ...item, id: item.id || newItemId() };
}

const normalize = <K extends ItemKind>(kind: K, raw: unknown): ItemOf<K> =>
  (kind === 'vocab' ? ensureFSRSVocab(raw) : ensureFSRSGrammar(raw)) as ItemOf<K>;

/** Chỉ thông tin nội dung của thẻ. FSRS tuyệt đối thuộc study_data. */
function contentOf(item: AnyItem): Record<string, unknown> {
  const data: Record<string, unknown> = { ...item };
  delete data.id;
  for (const key of FSRS_KEYS) delete data[key];
  return data;
}

export function pickFSRSFields(item: AnyItem): Partial<AnyItem> {
  const out: Record<string, unknown> = {};
  for (const key of FSRS_KEYS) if (key in item) out[key] = (item as unknown as Record<string, unknown>)[key];
  return out as Partial<AnyItem>;
}

const toInt = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : 0;
const toNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0;

function toItemRow(userId: string, item: AnyItem): ItemRow {
  return { user_id: userId, id: item.id, data: contentOf(item), updated_at: new Date().toISOString() };
}

export function toStudyEntry(item: AnyItem): StudyEntry {
  return {
    state: toInt(item.state),
    stability: toNum(item.stability),
    difficulty: toNum(item.difficulty),
    reps: toInt(item.reps),
    lapses: toInt(item.lapses),
    scheduled_days: toInt(item.scheduled_days),
    elapsed_days: toInt(item.elapsed_days),
    learning_steps: toInt(item.learning_steps),
    reviewDate: item.reviewDate || null,
    last_review: item.last_review || null,
    next_review: item.next_review || new Date().toISOString(),
  };
}

export function studyEntryToFields(entry: Partial<StudyEntry>): Partial<AnyItem> {
  const fields: Record<string, unknown> = {};
  const numeric = ['state', 'stability', 'difficulty', 'reps', 'lapses', 'scheduled_days', 'elapsed_days', 'learning_steps'] as const;
  for (const key of numeric) {
    const value = entry[key];
    if (typeof value === 'number' && Number.isFinite(value)) fields[key] = value;
  }
  if ('scheduled_days' in fields) fields.interval = fields.scheduled_days;
  if ('reps' in fields) fields.repetition = fields.reps;
  if (typeof entry.next_review === 'string') fields.next_review = entry.next_review;
  if (typeof entry.last_review === 'string') fields.last_review = entry.last_review;
  if (entry.reviewDate) fields.reviewDate = entry.reviewDate;
  return fields as Partial<AnyItem>;
}

function parseJSONColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

export function parseStudyMap(value: unknown): StudyMap {
  const parsed = parseJSONColumn(value);
  const out: StudyMap = {};
  if (Array.isArray(parsed)) {
    for (const raw of parsed) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as AnyItem;
      if (typeof item.id === 'string') out[item.id] = toStudyEntry(item);
    }
    return out;
  }
  if (!parsed || typeof parsed !== 'object') return out;
  for (const [id, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (entry && typeof entry === 'object') out[id] = entry as StudyEntry;
  }
  return out;
}

export function rowsToItem<K extends ItemKind>(kind: K, row: Pick<ItemRow, 'id' | 'data'>, study?: Partial<StudyEntry> | null, fallbackFSRS?: Partial<AnyItem>): ItemOf<K> {
  return normalize(kind, { ...row.data, ...(fallbackFSRS || {}), ...(study ? studyEntryToFields(study) : {}), id: row.id });
}

function chunk<T>(rows: T[]): T[][] {
  const out: T[][] = [];
  let batch: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (batch.length && (batch.length >= WRITE_CHUNK_ROWS || bytes + size > WRITE_CHUNK_BYTES)) {
      out.push(batch); batch = []; bytes = 0;
    }
    batch.push(row); bytes += size;
  }
  if (batch.length) out.push(batch);
  return out;
}

const label = (kind: ItemKind) => kind === 'vocab' ? 'từ vựng' : 'ngữ pháp';

async function fetchAll<T>(table: string, userId: string, action: string): Promise<T[]> {
  const rows: T[] = [];
  try {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase.from(table).select('user_id,id,data,updated_at').eq('user_id', userId).order('id', { ascending: true }).range(from, from + PAGE_SIZE - 1);
      if (error) fail(action, error);
      rows.push(...((data as T[]) || []));
      if (!data || data.length < PAGE_SIZE) return rows;
    }
  } catch (error) {
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

export async function fetchStudySnapshot(): Promise<StudySnapshot> {
  const action = 'tải dữ liệu học tập từ Supabase';
  const userId = await requireUserId(action);
  try {
    const { data, error } = await supabase.from(STUDY_TABLE).select('*').eq('user_id', userId).maybeSingle();
    if (error) fail(action, error);
    return {
      user_id: userId,
      vocab: parseStudyMap(data?.vocab),
      grammar: parseStudyMap(data?.grammar),
      progress: data?.progress && typeof data.progress === 'object' ? data.progress as UserRankData : null,
      settings: data?.settings && typeof data.settings === 'object' ? data.settings as Record<string, unknown> : {},
      history: Array.isArray(data?.history) ? data.history as ReviewLog[] : [],
      updated_at: data?.updated_at,
    };
  } catch (error) {
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

/** Cập nhật đúng một entry FSRS bằng RPC JSONB, tránh hai thiết bị ghi đè map của nhau. */
export async function saveStudyData(kind: ItemKind, item: AnyItem): Promise<void> {
  await saveStudyDataBatch(kind, [item]);
}

export async function saveStudyDataBatch(kind: ItemKind, items: AnyItem[]): Promise<void> {
  if (!items.length) return;
  const action = `lưu thông số FSRS ${label(kind)} lên Supabase`;
  const userId = await requireUserId(action);
  try {
    for (const item of items) {
      const { error } = await supabase.rpc('upsert_study_entry', {
        p_kind: kind,
        p_item_id: item.id,
        p_entry: toStudyEntry(item),
      });
      if (error) fail(action, error);
    }
  } catch (error) {
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

/** Ghi settings/progress/history vào cùng một study_data row. */
export async function saveStudyMeta(meta: Partial<Pick<StudySnapshot, 'progress' | 'settings' | 'history'>>): Promise<void> {
  const action = 'lưu tiến trình học tập lên Supabase';
  const userId = await requireUserId(action);
  try {
    if (meta.progress === undefined && meta.settings === undefined && meta.history === undefined) return;
    const { error } = await supabase.rpc('merge_study_meta', {
      p_progress: meta.progress ?? null,
      p_settings: meta.settings ?? null,
      p_history: meta.history ?? [],
    });
    if (error) fail(action, error);
  } catch (error) {
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

export async function deleteStudyEntries(kind: ItemKind, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const action = `xóa dữ liệu học tập ${label(kind)} trên Supabase`;
  await requireUserId(action);
  try {
    for (const id of ids) {
      const { error } = await supabase.rpc('remove_study_entry', { p_kind: kind, p_item_id: id });
      if (error) fail(action, error);
    }
  } catch (error) {
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

export interface SupabaseUserData {
  vocab: VocabItem[];
  grammar: GrammarItem[];
  missingStudy: { vocab: VocabItem[]; grammar: GrammarItem[] };
  legacy: { vocab: VocabItem[]; grammar: GrammarItem[] };
  study: StudySnapshot;
}

export async function fetchAllUserData(): Promise<SupabaseUserData> {
  const action = 'tải dữ liệu từ Supabase';
  const userId = await requireUserId(action);
  try {
    const [vocabRows, grammarRows, study] = await Promise.all([
      fetchAll<ItemRow>(ITEM_TABLE.vocab, userId, action),
      fetchAll<ItemRow>(ITEM_TABLE.grammar, userId, action),
      fetchStudySnapshot(),
    ]);

    const build = <K extends ItemKind>(kind: K, rows: ItemRow[]): ItemOf<K>[] => rows.map((row) => {
      const studyEntry = study[kind][row.id];
      const legacyFSRS = pickFSRSFields(row.data as AnyItem);
      return rowsToItem(kind, row, studyEntry, legacyFSRS);
    }).sort((a, b) => String((b as AnyItem).createdAt || '').localeCompare(String((a as AnyItem).createdAt || '')));

    const vocab = build('vocab', vocabRows);
    const grammar = build('grammar', grammarRows);
    const missingStudy = {
      vocab: vocab.filter((item) => !study.vocab[item.id]),
      grammar: grammar.filter((item) => !study.grammar[item.id]),
    };
    return { vocab, grammar, missingStudy, legacy: { vocab: [], grammar: [] }, study };
  } catch (error) {
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

export async function createItem<K extends ItemKind>(kind: K, rawItem: ItemOf<K>): Promise<ItemOf<K>> {
  const action = `lưu ${label(kind)} mới lên Supabase`;
  const userId = await requireUserId(action);
  const item = withItemId(rawItem) as ItemOf<K>;
  const row = toItemRow(userId, item);
  try {
    const { data, error } = await supabase.from(ITEM_TABLE[kind]).insert(row).select('id,data').single();
    if (error || !data) fail(action, error ?? new Error('Supabase không trả về thẻ mới'));
    await saveStudyData(kind, item);
    return rowsToItem(kind, data as ItemRow, toStudyEntry(item));
  } catch (error) {
    // Không để lại item mồ côi nếu khởi tạo study_data thất bại.
    try { await supabase.from(ITEM_TABLE[kind]).delete().eq('user_id', userId).eq('id', item.id); } catch {}
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

export async function updateItemContent(kind: ItemKind, item: AnyItem): Promise<void> {
  const action = `lưu thay đổi ${label(kind)} lên Supabase`;
  const userId = await requireUserId(action);
  try {
    const row = toItemRow(userId, item);
    const { error } = await supabase.from(ITEM_TABLE[kind]).upsert(row, { onConflict: 'user_id,id' });
    if (error) fail(action, error);
  } catch (error) {
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

/** Sửa thẻ: nội dung + study_data đều phải thành công. */
export async function saveItem(kind: ItemKind, item: AnyItem): Promise<void> {
  const action = `lưu ${label(kind)} lên Supabase`;
  const userId = await requireUserId(action);
  let previous: ItemRow | null = null;
  try {
    const { data, error } = await supabase.from(ITEM_TABLE[kind]).select('user_id,id,data,updated_at').eq('user_id', userId).eq('id', item.id).maybeSingle();
    if (error) fail(action, error);
    previous = data as ItemRow | null;

    await updateItemContent(kind, item);
    await saveStudyData(kind, item);
  } catch (error) {
    // Keep the operation transactional from the user's point of view: if study_data
    // cannot be persisted, restore the previous content row.
    try {
      if (previous) {
        await supabase.from(ITEM_TABLE[kind]).upsert(previous, { onConflict: 'user_id,id' });
      } else {
        await supabase.from(ITEM_TABLE[kind]).delete().eq('user_id', userId).eq('id', item.id);
      }
    } catch (rollbackError) {
      console.error('Supabase rollback failed:', rollbackError);
    }
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

export async function bulkSaveItems(kind: ItemKind, items: AnyItem[]): Promise<void> {
  if (!items.length) return;
  const action = `lưu ${items.length} ${label(kind)} lên Supabase`;
  const userId = await requireUserId(action);
  try {
    for (const rows of chunk(items.map((item) => toItemRow(userId, item)))) {
      const { error } = await supabase.from(ITEM_TABLE[kind]).upsert(rows, { onConflict: 'user_id,id' });
      if (error) fail(action, error);
    }
    await saveStudyDataBatch(kind, items);
  } catch (error) {
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}

export async function deleteItems(kind: ItemKind, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const action = `xóa ${label(kind)} trên Supabase`;
  const userId = await requireUserId(action);
  try {
    // Snapshot the rows so a failed study_data delete can restore the item rows.
    const { data: existing, error: readError } = await supabase
      .from(ITEM_TABLE[kind])
      .select('user_id,id,data,updated_at')
      .eq('user_id', userId)
      .in('id', ids);
    if (readError) fail(action, readError);

    for (let i = 0; i < ids.length; i += WRITE_CHUNK_ROWS) {
      const part = ids.slice(i, i + WRITE_CHUNK_ROWS);
      const { error } = await supabase.from(ITEM_TABLE[kind]).delete().eq('user_id', userId).in('id', part);
      if (error) fail(action, error);
    }

    try {
      await deleteStudyEntries(kind, ids);
    } catch (studyError) {
      if (existing?.length) await supabase.from(ITEM_TABLE[kind]).upsert(existing, { onConflict: 'user_id,id' });
      throw studyError;
    }
  } catch (error) {
    if (error instanceof SupabaseSyncError) throw error;
    fail(action, error);
  }
}
