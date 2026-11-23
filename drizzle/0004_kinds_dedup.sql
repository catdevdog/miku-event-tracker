PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_events` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`officiality` text NOT NULL,
	`region` text NOT NULL,
	`city` text,
	`venue` text,
	`start_date` text,
	`end_date` text,
	`ticket_open_at` text,
	`ticket_url` text,
	`status` text DEFAULT 'announced' NOT NULL,
	`parent_event_id` integer,
	`summary_ko` text,
	`dedup_key` text NOT NULL,
	`needs_review` integer DEFAULT 0 NOT NULL,
	`merged_into` integer,
	`aliases` text DEFAULT '[]' NOT NULL,
	`dup_of_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`parent_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`merged_into`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dup_of_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_kind_check" CHECK(kind IN ('concert','booth','stage','popup','cafe','exhibition','live_viewing','goods','collab','other')),
	CONSTRAINT "events_officiality_check" CHECK(officiality IN ('crypton','licensed','permitted_doujin','unverified')),
	CONSTRAINT "events_region_check" CHECK(region IN ('KR','JP','OTHER')),
	CONSTRAINT "events_status_check" CHECK(status IN ('announced','ticket_scheduled','on_sale','ongoing','ended','cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_events`("id", "title", "kind", "officiality", "region", "city", "venue", "start_date", "end_date", "ticket_open_at", "ticket_url", "status", "parent_event_id", "summary_ko", "dedup_key", "needs_review", "merged_into", "created_at", "updated_at") SELECT "id", "title", "kind", "officiality", "region", "city", "venue", "start_date", "end_date", "ticket_open_at", "ticket_url", "status", "parent_event_id", "summary_ko", "dedup_key", "needs_review", "merged_into", "created_at", "updated_at" FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedup_key_unique` ON `events` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `idx_events_dates` ON `events` (`start_date`,`status`);--> statement-breakpoint
CREATE INDEX `idx_events_parent` ON `events` (`parent_event_id`);