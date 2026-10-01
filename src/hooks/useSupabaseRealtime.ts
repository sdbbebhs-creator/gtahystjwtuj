import { useEffect, useRef } from 'react';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { supabase } from '../utils/supabaseClient';
import { ITEM_TABLE, STUDY_TABLE, parseStudyMap, type ItemKind, type ItemRow, type StudySnapshot, type StudyRow } from '../utils/supabaseItems';

export interface RealtimeHandlers {
  onItemUpsert: (kind: ItemKind, row: ItemRow) => void;
  onItemDelete: (kind: ItemKind, id: string) => void;
  onStudyUpsert: (snapshot: StudySnapshot) => void;
  onStudyDelete: () => void;
  onResync: () => void;
}

const KINDS: ItemKind[] = ['vocab', 'grammar'];

export function useSupabaseRealtime(userId: string | null, accessToken: string | null, handlers: RealtimeHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (accessToken) supabase.realtime.setAuth(accessToken);
  }, [accessToken]);

  useEffect(() => {
    if (!userId) return;

    const isMine = (row: { user_id?: string } | null | undefined) => !row?.user_id || row.user_id === userId;

    const onItemChange = (kind: ItemKind) => (payload: RealtimePostgresChangesPayload<ItemRow>) => {
      try {
        if (payload.eventType === 'DELETE') {
          const old = payload.old as Partial<ItemRow>;
          if (old?.id && isMine(old)) handlersRef.current.onItemDelete(kind, old.id);
          return;
        }
        const row = payload.new as ItemRow;
        if (row?.id && row.data && isMine(row)) handlersRef.current.onItemUpsert(kind, row);
      } catch (error) {
        console.error('Supabase Realtime item error:', error);
      }
    };

    const onStudyChange = (payload: RealtimePostgresChangesPayload<StudyRow>) => {
      try {
        if (payload.eventType === 'DELETE') {
          const old = payload.old as Partial<StudyRow>;
          if (isMine(old)) handlersRef.current.onStudyDelete();
          return;
        }
        const row = payload.new as StudyRow;
        if (!row || !isMine(row)) return;
        handlersRef.current.onStudyUpsert({
          user_id: row.user_id,
          vocab: parseStudyMap(row.vocab),
          grammar: parseStudyMap(row.grammar),
          progress: row.progress && typeof row.progress === 'object' ? row.progress : null,
          settings: row.settings && typeof row.settings === 'object' ? row.settings as Record<string, unknown> : {},
          history: Array.isArray(row.history) ? row.history : [],
          updated_at: row.updated_at,
        });
      } catch (error) {
        console.error('Supabase Realtime study_data error:', error);
      }
    };

    const filter = `user_id=eq.${userId}`;
    const channel: RealtimeChannel = supabase.channel(`user-data:${userId}`);

    for (const kind of KINDS) {
      const table = ITEM_TABLE[kind];
      channel
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table, filter }, onItemChange(kind))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table, filter }, onItemChange(kind))
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table }, onItemChange(kind));
    }

    channel
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: STUDY_TABLE, filter }, onStudyChange)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: STUDY_TABLE, filter }, onStudyChange)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: STUDY_TABLE }, onStudyChange);

    let hasSubscribed = false;
    channel.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        console.log('Supabase Realtime: đã kết nối', channel.topic);
        if (hasSubscribed) handlersRef.current.onResync();
        hasSubscribed = true;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error('Supabase Realtime Error:', status, err);
      }
    });

    const onVisible = () => {
      if (document.visibilityState === 'visible') handlersRef.current.onResync();
    };
    const onOnline = () => handlersRef.current.onResync();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      supabase.removeChannel(channel);
    };
  }, [userId]);
}
