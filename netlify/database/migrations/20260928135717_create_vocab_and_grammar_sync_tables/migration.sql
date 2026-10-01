CREATE TABLE "grammar_items" (
	"user_id" text,
	"id" text,
	"data" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "grammar_items_pkey" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "vocab_items" (
	"user_id" text,
	"id" text,
	"data" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "vocab_items_pkey" PRIMARY KEY("user_id","id")
);
