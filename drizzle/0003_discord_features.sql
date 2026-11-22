CREATE TABLE `discord_members` (
	`user_id` text PRIMARY KEY NOT NULL,
	`initialized_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `discord_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `event_watchers` (
	`event_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`event_id`, `user_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` integer PRIMARY KEY NOT NULL,
	`raw_item_id` integer,
	`url` text,
	`note` text,
	`reporter_id` text NOT NULL,
	`admin_message_id` text,
	`result` text,
	`resolved_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sources` (
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
	`paused` integer DEFAULT 0 NOT NULL,
	`last_run_at` text,
	`last_success_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "sources_layer_check" CHECK(layer IN ('L1','L2','L3','L4')),
	CONSTRAINT "sources_adapter_check" CHECK(adapter IN ('rss','html_diff','playwright','x_crawl','instagram','kopis','naver','ticket','manual')),
	CONSTRAINT "sources_region_check" CHECK(region IN ('KR','JP','GLOBAL')),
	CONSTRAINT "sources_config_check" CHECK(json_valid(config)),
	CONSTRAINT "sources_state_check" CHECK(json_valid(state))
);
--> statement-breakpoint
INSERT INTO `__new_sources`("id", "name", "layer", "adapter", "target", "region", "interval_min", "boost_interval_min", "config", "state", "enabled", "last_run_at", "last_success_at", "consecutive_failures", "created_at") SELECT "id", "name", "layer", "adapter", "target", "region", "interval_min", "boost_interval_min", "config", "state", "enabled", "last_run_at", "last_success_at", "consecutive_failures", "created_at" FROM `sources`;--> statement-breakpoint
DROP TABLE `sources`;--> statement-breakpoint
ALTER TABLE `__new_sources` RENAME TO `sources`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sources_name_unique` ON `sources` (`name`);--> statement-breakpoint
ALTER TABLE `event_discord` ADD `notice_message_id` text;--> statement-breakpoint
ALTER TABLE `event_discord` ADD `notice_thread_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `merged_into` integer REFERENCES events(id);--> statement-breakpoint
ALTER TABLE `keywords` ADD `disabled` integer DEFAULT 0 NOT NULL;