import { pgTable, text, jsonb, timestamp, primaryKey } from 'drizzle-orm/pg-core';

/** Canonical cloud schema: exactly three application tables. */
export const vocabItems = pgTable(
  'vocab_items',
  {
    userId: text('user_id').notNull(),
    id: text('id').notNull(),
    data: jsonb('data').notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })]
);

export const grammarItems = pgTable(
  'grammar_items',
  {
    userId: text('user_id').notNull(),
    id: text('id').notNull(),
    data: jsonb('data').notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })]
);

/**
 * One row per user. This is the single source of truth for learning state:
 * FSRS maps, rank/streak/EXP, settings and review history.
 */
export const studyData = pgTable(
  'study_data',
  {
    userId: text('user_id').notNull(),
    vocab: jsonb('vocab').notNull(),
    grammar: jsonb('grammar').notNull(),
    progress: jsonb('progress').notNull(),
    settings: jsonb('settings').notNull(),
    history: jsonb('history').notNull(),
    updatedAt: timestamp('updated_at').defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId] })]
);
