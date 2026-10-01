CREATE TABLE "review_logs" (
	"user_id" text,
	"id" text,
	"ts" text NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "review_logs_pkey" PRIMARY KEY("user_id","id")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text,
	"key" text,
	"data" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "user_settings_pkey" PRIMARY KEY("user_id","key")
);
--> statement-breakpoint
CREATE INDEX "review_logs_user_ts_idx" ON "review_logs" ("user_id","ts");