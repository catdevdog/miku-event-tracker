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
	`last_run_at` text,
	`last_success_at` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT "sources_layer_check" CHECK(layer IN ('L1','L2','L3','L4')),
	CONSTRAINT "sources_adapter_check" CHECK(adapter IN ('rss','html_diff','playwright','x_crawl','instagram','kopis','naver','ticket')),
	CONSTRAINT "sources_region_check" CHECK(region IN ('KR','JP','GLOBAL')),
	CONSTRAINT "sources_config_check" CHECK(json_valid(config)),
	CONSTRAINT "sources_state_check" CHECK(json_valid(state))
);
--> statement-breakpoint
INSERT INTO `__new_sources`("id", "name", "layer", "adapter", "target", "region", "interval_min", "boost_interval_min", "config", "state", "enabled", "last_run_at", "last_success_at", "consecutive_failures", "created_at") SELECT "id", "name", "layer", "adapter", "target", "region", "interval_min", "boost_interval_min", "config", "state", "enabled", "last_run_at", "last_success_at", "consecutive_failures", "created_at" FROM `sources`;--> statement-breakpoint
DROP TABLE `sources`;--> statement-breakpoint
ALTER TABLE `__new_sources` RENAME TO `sources`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sources_name_unique` ON `sources` (`name`);