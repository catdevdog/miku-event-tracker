CREATE TABLE `event_attendees` (
	`event_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`event_id`, `user_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `event_distinct` (
	`a_id` integer NOT NULL,
	`b_id` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`a_id`, `b_id`),
	FOREIGN KEY (`a_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`b_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `event_discord` ADD `dup_message_id` text;--> statement-breakpoint
ALTER TABLE `events` ADD `presales` text DEFAULT '[]' NOT NULL;