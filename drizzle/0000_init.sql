CREATE TABLE `event_sources` (
	`event_id` integer NOT NULL,
	`raw_item_id` integer NOT NULL,
	`extracted` text NOT NULL,
	`confidence` real,
	`model` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`event_id`, `raw_item_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "event_sources_extracted_check" CHECK(json_valid(extracted))
);
--> statement-breakpoint
CREATE TABLE `event_state_log` (
	`id` integer PRIMARY KEY NOT NULL,
	`event_id` integer NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`changed_fields` text,
	`raw_item_id` integer,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "event_state_log_changed_fields_check" CHECK(changed_fields IS NULL OR json_valid(changed_fields))
);
--> statement-breakpoint
CREATE INDEX `idx_state_log_event` ON `event_state_log` (`event_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `events` (
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
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`parent_event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_kind_check" CHECK(kind IN ('concert','booth','stage','popup','cafe','exhibition','live_viewing','goods','other')),
	CONSTRAINT "events_officiality_check" CHECK(officiality IN ('crypton','licensed','permitted_doujin','unverified')),
	CONSTRAINT "events_region_check" CHECK(region IN ('KR','JP','OTHER')),
	CONSTRAINT "events_status_check" CHECK(status IN ('announced','ticket_scheduled','on_sale','ongoing','ended','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_dedup_key_unique` ON `events` (`dedup_key`);--> statement-breakpoint
CREATE INDEX `idx_events_dates` ON `events` (`start_date`,`status`);--> statement-breakpoint
CREATE INDEX `idx_events_parent` ON `events` (`parent_event_id`);--> statement-breakpoint
CREATE TABLE `job_locks` (
	`name` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`locked_until` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`source_id` integer NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`items_new` integer DEFAULT 0 NOT NULL,
	`error` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_runs_status_check" CHECK(status IN ('running','ok','error','skipped'))
);
--> statement-breakpoint
CREATE INDEX `idx_job_runs_source` ON `job_runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `keywords` (
	`id` integer PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`tier` text NOT NULL,
	`lang` text,
	CONSTRAINT "keywords_tier_check" CHECK(tier IN ('strong','weak','context','exclude'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `keywords_term_unique` ON `keywords` (`term`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` integer PRIMARY KEY NOT NULL,
	`raw_item_id` integer,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `misses` (
	`id` integer PRIMARY KEY NOT NULL,
	`event_id` integer,
	`noticed_at` text NOT NULL,
	`first_seen_source` text,
	`caught_by_system` integer NOT NULL,
	`system_lag_min` integer,
	`note` text,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY NOT NULL,
	`event_id` integer NOT NULL,
	`subscriber_id` integer NOT NULL,
	`reason` text NOT NULL,
	`event_status` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`sent_at` text,
	`error` text,
	`slot` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subscriber_id`) REFERENCES `subscribers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notifications_reason_check" CHECK(reason IN ('new','status_change','reminder')),
	CONSTRAINT "notifications_status_check" CHECK(status IN ('queued','sent','failed'))
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_status` ON `notifications` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedup_unique` ON `notifications` (`event_id`,`subscriber_id`,`reason`,`event_status`,`slot`);--> statement-breakpoint
CREATE TABLE `raw_items` (
	`id` integer PRIMARY KEY NOT NULL,
	`source_id` integer NOT NULL,
	`external_id` text NOT NULL,
	`url` text,
	`title` text,
	`body` text,
	`lang` text,
	`published_at` text,
	`fetched_at` text DEFAULT (datetime('now')) NOT NULL,
	`content_hash` text NOT NULL,
	`keyword_hit` text,
	`llm_status` text DEFAULT 'pending' NOT NULL,
	`purge_after` text,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "raw_items_keyword_hit_check" CHECK(keyword_hit IN ('strong','weak','none')),
	CONSTRAINT "raw_items_llm_status_check" CHECK(llm_status IN ('pending','done','skipped','error'))
);
--> statement-breakpoint
CREATE INDEX `idx_raw_items_llm` ON `raw_items` (`llm_status`);--> statement-breakpoint
CREATE INDEX `idx_raw_items_purge` ON `raw_items` (`purge_after`);--> statement-breakpoint
CREATE UNIQUE INDEX `raw_items_source_external_unique` ON `raw_items` (`source_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`layer` text NOT NULL,
	`adapter` text NOT NULL,
	`target` text NOT NULL,
	`region` text NOT NULL,
	`interval_min` integer NOT NULL,
	`boost_interval_min` integer,
	`config` text DEFAULT '{}' NOT NULL,
	`state` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`last_run_at` text,
	`last_success_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "sources_layer_check" CHECK(layer IN ('L1','L2','L3','L4')),
	CONSTRAINT "sources_adapter_check" CHECK(adapter IN ('rss','html_diff','playwright','x_crawl','instagram','kopis','naver')),
	CONSTRAINT "sources_region_check" CHECK(region IN ('KR','JP','GLOBAL')),
	CONSTRAINT "sources_config_check" CHECK(json_valid(config)),
	CONSTRAINT "sources_state_check" CHECK(json_valid(state))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_name_unique` ON `sources` (`name`);--> statement-breakpoint
CREATE TABLE `subscribers` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`channel` text NOT NULL,
	`target` text NOT NULL,
	`filters` text DEFAULT '{}' NOT NULL,
	`is_admin` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "subscribers_channel_check" CHECK(channel IN ('discord_channel','discord_dm')),
	CONSTRAINT "subscribers_filters_check" CHECK(json_valid(filters))
);
