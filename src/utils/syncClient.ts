import { supabase } from './supabaseClient';
import {
  fetchAllUserData,
  saveStudyMeta,
  type StudySnapshot,
} from './supabaseItems';
import {
  getReviewLogs,
  setReviewLogs,
  readSyncedSettings,
  writeSyncedSettings,
  SYNCED_SETTING_KEYS,
} from './storage';
import { getUserRankData, saveUserRankData } from './rankSystem';
import type { VocabItem, GrammarItem } from '../types';

export interface SyncedData {
  vocab: VocabItem[];
  grammar: GrammarItem[];
  settingsChanged: boolean;
  logsChanged: boolean;
}

function isEmptyStudy(study: StudySnapshot): boolean {
  return (
    Object.keys(study.vocab).length === 0 &&
    Object.keys(study.grammar).length === 0 &&
    !study.progress &&
    Object.keys(study.settings).length === 0 &&
    study.history.length === 0
  );
}

function localSettingsObject(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(readSyncedSettings())) {
    if (raw == null) continue;
    try { out[key] = JSON.parse(String(raw)); } catch { out[key] = raw; }
  }
  return out;
}

function cloudSettingsToLocal(settings: Record<string, unknown>): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const key of SYNCED_SETTING_KEYS) {
    const value = settings[key];
    out[key] = value === undefined ? null : (typeof value === 'string' ? value : JSON.stringify(value));
  }
  return out;
}

function localStudySnapshot(): Pick<StudySnapshot, 'progress' | 'settings' | 'history'> {
  return {
    progress: getUserRankData(),
    settings: localSettingsObject(),
    history: getReviewLogs(),
  };
}

/**
 * Đồng bộ nguồn học tập duy nhất: study_data.
 */
export async function pullAndMerge(
  _userId: string,
  localVocab: VocabItem[],
  localGrammar: GrammarItem[]
): Promise<SyncedData> {
  try {
    const remote = await fetchAllUserData();
    let vocab = remote.vocab;
    let grammar = remote.grammar;

    // Khi study_data + item tables hoàn toàn mới, cho phép migrate dữ liệu local cũ một lần.
    if (vocab.length === 0 && grammar.length === 0 && (localVocab.length || localGrammar.length)) {
      vocab = localVocab;
      grammar = localGrammar;
      const { bulkSaveItems } = await import('./supabaseItems');
      if (vocab.length) await bulkSaveItems('vocab', vocab);
      if (grammar.length) await bulkSaveItems('grammar', grammar);
    }

    const emptyCloudStudy = isEmptyStudy(remote.study);
    let settingsChanged = false;
    let logsChanged = false;

    if (emptyCloudStudy) {
      const local = localStudySnapshot();
      if (local.progress || Object.keys(local.settings).length || local.history.length) {
        await saveStudyMeta(local);
      }
    } else {
      if (remote.study.progress) {
        saveUserRankData(remote.study.progress);
        settingsChanged = true;
      }
      const settings = cloudSettingsToLocal(remote.study.settings);
      if (Object.keys(settings).length) {
        writeSyncedSettings(settings);
        settingsChanged = true;
      }
      setReviewLogs(remote.study.history);
      logsChanged = true;
    }

    return { vocab, grammar, settingsChanged, logsChanged };
  } catch (error) {
    console.error('Supabase sync pull failed:', error);
    throw error;
  }
}

/** Ghi ngay progress/settings/history hiện tại vào study_data. */
export async function pushLocalChanges(
  _userId: string,
  _vocab: VocabItem[],
  _grammar: GrammarItem[]
): Promise<boolean> {
  try {
    await saveStudyMeta(localStudySnapshot());
    return true;
  } catch (error) {
    console.error('Supabase sync push failed:', error);
    throw error;
  }
}

export function getStudyMetaForRealtime(): Pick<StudySnapshot, 'progress' | 'settings' | 'history'> {
  return localStudySnapshot();
}

// Keep a direct auth check available to callers that need a sync guard.
export async function requireAuthenticatedUser(): Promise<string> {
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user?.id) throw error ?? new Error('Not signed in');
    return data.user.id;
  } catch (error) {
    console.error('Supabase auth check failed:', error);
    throw error;
  }
}
